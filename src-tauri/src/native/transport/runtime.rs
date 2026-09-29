use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tokio::{
    net::UdpSocket,
    sync::{broadcast, Notify},
    time,
};
use voxa_native_core::protocol;

#[derive(Default)]
pub(super) struct WakeSignal {
    pending: Mutex<bool>,
    blocking: Condvar,
    asynchronous: Notify,
}

impl WakeSignal {
    pub(super) fn notify(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            *pending = true;
            self.blocking.notify_all();
        }
        self.asynchronous.notify_one();
    }

    pub(super) fn wait_blocking(&self, timeout: Duration) {
        let Ok(pending) = self.pending.lock() else {
            return;
        };
        let Ok((mut pending, _)) = self
            .blocking
            .wait_timeout_while(pending, timeout, |pending| !*pending)
        else {
            return;
        };
        *pending = false;
    }

    pub(super) async fn wait_async(&self) {
        // Notify armazena uma permissao quando o produtor chega antes do
        // consumidor. O bit pending tambem atende o consumidor bloqueante.
        self.asynchronous.notified().await;
        if let Ok(mut pending) = self.pending.lock() {
            *pending = false;
        }
    }
}

#[derive(Clone)]
pub struct DatagramHub {
    pub(super) socket: Arc<UdpSocket>,
    sender: broadcast::Sender<(Arc<Vec<u8>>, SocketAddr)>,
    stop: Arc<AtomicBool>,
}

impl DatagramHub {
    pub fn new(socket: Arc<UdpSocket>) -> Self {
        let (sender, _) = broadcast::channel(4_096);
        let stop = Arc::new(AtomicBool::new(false));
        let read_socket = socket.clone();
        let read_sender = sender.clone();
        let read_stop = stop.clone();
        tauri::async_runtime::spawn(async move {
            let mut buffer = [0u8; protocol::MAX_DATAGRAM];
            while !read_stop.load(Ordering::Acquire) {
                match time::timeout(
                    Duration::from_millis(100),
                    read_socket.recv_from(&mut buffer),
                )
                .await
                {
                    Ok(Ok((len, source)))
                        if len >= protocol::HEADER_LEN
                            && buffer[..4] == *b"VOXA"
                            && buffer[4] == protocol::VERSION =>
                    {
                        let _ = read_sender.send((Arc::new(buffer[..len].to_vec()), source));
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(_)) => time::sleep(Duration::from_millis(25)).await,
                    Err(_) => {}
                }
            }
        });
        Self {
            socket,
            sender,
            stop,
        }
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<(Arc<Vec<u8>>, SocketAddr)> {
        self.sender.subscribe()
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}
