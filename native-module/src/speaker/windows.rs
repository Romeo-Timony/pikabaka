// Ported logic
use crate::audio_config::RING_BUFFER_SAMPLES;
use anyhow::Result;
use ringbuf::{
    traits::{Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::collections::VecDeque;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
use tracing::error;
use wasapi::{get_default_device, DeviceCollection, Direction, SampleType, ShareMode};

struct WakerState {
    shutdown: bool,
}

pub struct SpeakerInput {
    device_id: Option<String>,
}

pub struct SpeakerStream {
    consumer: Option<HeapCons<f32>>,
    waker_state: Arc<Mutex<WakerState>>,
    capture_thread: Option<thread::JoinHandle<()>>,
    actual_sample_rate: u32,
    data_ready: Arc<(Mutex<bool>, Condvar)>,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.actual_sample_rate
    }

    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }

    pub fn data_ready_signal(&self) -> Arc<(Mutex<bool>, Condvar)> {
        self.data_ready.clone()
    }
}

// Helper to find device by ID
fn find_device_by_id(direction: &Direction, device_id: &str) -> Option<wasapi::Device> {
    let collection = DeviceCollection::new(direction).ok()?;
    let count = collection.get_nbr_devices().ok()?;

    for i in 0..count {
        if let Ok(device) = collection.get_device_at_index(i) {
            if let Ok(id) = device.get_id() {
                if id == device_id {
                    return Some(device);
                }
            }
        }
    }
    None
}

pub fn list_output_devices() -> Result<Vec<(String, String)>> {
    let collection =
        DeviceCollection::new(&Direction::Render).map_err(|e| anyhow::anyhow!("{}", e))?;
    let count = collection
        .get_nbr_devices()
        .map_err(|e| anyhow::anyhow!("{}", e))?;
    let mut list = Vec::new();

    for i in 0..count {
        if let Ok(device) = collection.get_device_at_index(i) {
            let id = device.get_id().unwrap_or_default();
            let name = device.get_friendlyname().unwrap_or_default();
            if !id.is_empty() {
                list.push((id, name));
            }
        }
    }
    Ok(list)
}

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let device_id = device_id.filter(|id| !id.is_empty() && id != "default");
        Ok(Self { device_id })
    }

    pub fn stream(self) -> Result<SpeakerStream> {
        let rb = HeapRb::<f32>::new(RING_BUFFER_SAMPLES);
        let (producer, consumer) = rb.split();

        let waker_state = Arc::new(Mutex::new(WakerState { shutdown: false }));
        let data_ready = Arc::new((Mutex::new(false), Condvar::new()));
        let (init_tx, init_rx) = mpsc::channel();

        let waker_clone = waker_state.clone();
        let data_ready_clone = data_ready.clone();
        let device_id = self.device_id;

        let capture_thread = thread::spawn(move || {
            if let Err(e) = Self::capture_audio_loop(
                producer,
                waker_clone,
                data_ready_clone,
                init_tx,
                device_id,
            ) {
                error!("Audio capture loop failed: {}", e);
            }
        });

        let actual_sample_rate = match init_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(rate)) => rate,
            Ok(Err(e)) => {
                return Err(anyhow::anyhow!("Audio initialization failed: {}", e));
            }
            Err(_) => {
                return Err(anyhow::anyhow!("Audio initialization timeout"));
            }
        };

        Ok(SpeakerStream {
            consumer: Some(consumer),
            waker_state,
            capture_thread: Some(capture_thread),
            actual_sample_rate,
            data_ready,
        })
    }

    fn capture_audio_loop(
        mut producer: HeapProd<f32>,
        waker_state: Arc<Mutex<WakerState>>,
        data_ready: Arc<(Mutex<bool>, Condvar)>,
        init_tx: mpsc::Sender<Result<u32>>,
        device_id: Option<String>,
    ) -> Result<()> {
        let init_result = (|| -> Result<_> {
            let device = match device_id {
                Some(ref id) => match find_device_by_id(&Direction::Render, id) {
                    Some(d) => {
                        let name = d.get_friendlyname().unwrap_or_else(|_| id.clone());
                        println!("[SpeakerInput] Using render device: {} ({})", name, id);
                        d
                    }
                    None => {
                        println!(
                            "[SpeakerInput] Device {} not found — falling back to default render",
                            id
                        );
                        get_default_device(&Direction::Render)
                            .map_err(|e| anyhow::anyhow!("{}", e))?
                    }
                },
                None => {
                    println!("[SpeakerInput] Using default render device");
                    get_default_device(&Direction::Render).map_err(|e| anyhow::anyhow!("{}", e))?
                }
            };

            let mut audio_client = device
                .get_iaudioclient()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            // WASAPI loopback must match the device mix format. Forcing mono previously
            // produced silent captures on many stereo endpoints.
            let mix_format = audio_client
                .get_mixformat()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            let actual_rate = mix_format.get_samplespersec();
            let channels = mix_format.get_nchannels().max(1) as usize;
            let bits = mix_format.get_bitspersample().max(16) as usize;
            let sample_type = mix_format
                .get_subformat()
                .unwrap_or(SampleType::Float);
            println!(
                "[SpeakerInput] Mix format: {}Hz, {} ch, {} bit, {:?} — opening loopback",
                actual_rate, channels, bits, sample_type
            );

            let (_def_time, min_time) = audio_client
                .get_periods()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            // device=Render + Direction::Capture enables AUDCLNT_STREAMFLAGS_LOOPBACK
            audio_client
                .initialize_client(
                    &mix_format,
                    min_time,
                    &Direction::Capture,
                    &ShareMode::Shared,
                    true,
                )
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            let h_event = audio_client
                .set_get_eventhandle()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            let capture_client = audio_client
                .get_audiocaptureclient()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            audio_client
                .start_stream()
                .map_err(|e| anyhow::anyhow!("{}", e))?;

            Ok((
                h_event,
                capture_client,
                actual_rate,
                audio_client,
                channels,
                bits,
                sample_type,
            ))
        })();

        match init_result {
            Ok((
                h_event,
                capture_client,
                sample_rate,
                audio_client,
                channels,
                bits,
                sample_type,
            )) => {
                let _ = init_tx.send(Ok(sample_rate));
                let bytes_per_sample = (bits / 8).max(1) as usize;
                let bytes_per_frame = bytes_per_sample * channels.max(1);
                let is_float = matches!(sample_type, SampleType::Float);
                let mut frames_read: u64 = 0;
                let mut last_heartbeat = std::time::Instant::now();

                loop {
                    {
                        let state = waker_state.lock().unwrap();
                        if state.shutdown {
                            let _ = audio_client.stop_stream();
                            break;
                        }
                    }

                    if h_event.wait_for_event(3000).is_err() {
                        if last_heartbeat.elapsed() > Duration::from_secs(5) {
                            println!(
                                "[SpeakerInput] Waiting for loopback audio (frames_read={}). Is meeting audio playing on this output device?",
                                frames_read
                            );
                            last_heartbeat = std::time::Instant::now();
                        }
                        continue;
                    }

                    let mut temp_queue = VecDeque::new();
                    if let Err(e) =
                        capture_client.read_from_device_to_deque(bytes_per_frame, &mut temp_queue)
                    {
                        error!("Failed to read audio data: {}", e);
                        continue;
                    }

                    if temp_queue.is_empty() {
                        continue;
                    }

                    // Downmix interleaved frames to mono f32 for the DSP/STT pipeline.
                    let mut samples = Vec::with_capacity(temp_queue.len() / bytes_per_frame);
                    while temp_queue.len() >= bytes_per_frame {
                        let mut sum = 0.0f32;
                        for _ in 0..channels {
                            let mut bytes = vec![0u8; bytes_per_sample];
                            for b in bytes.iter_mut() {
                                *b = temp_queue.pop_front().unwrap();
                            }
                            let sample = if is_float && bytes_per_sample == 4 {
                                f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
                            } else if bytes_per_sample == 2 {
                                i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0
                            } else if bytes_per_sample == 4 {
                                // 32-bit PCM
                                i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32
                                    / 2147483648.0
                            } else {
                                0.0
                            };
                            sum += sample;
                        }
                        samples.push(sum / channels as f32);
                    }

                    if !samples.is_empty() {
                        frames_read = frames_read.saturating_add(samples.len() as u64);
                        let _ = producer.push_slice(&samples);

                        if last_heartbeat.elapsed() > Duration::from_secs(5) {
                            println!(
                                "[SpeakerInput] Loopback active: {} frames pushed ({} ch, {}-bit {:?})",
                                frames_read, channels, bits, sample_type
                            );
                            last_heartbeat = std::time::Instant::now();
                        }

                        let (lock, cvar) = &*data_ready;
                        let mut ready = lock.lock().unwrap();
                        *ready = true;
                        cvar.notify_all();
                    }
                }
            }
            Err(e) => {
                let _ = init_tx.send(Err(e));
            }
        }
        Ok(())
    }
}

// Implement Drop to stop the thread
impl Drop for SpeakerStream {
    fn drop(&mut self) {
        if let Ok(mut state) = self.waker_state.lock() {
            state.shutdown = true;
        }
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
    }
}
