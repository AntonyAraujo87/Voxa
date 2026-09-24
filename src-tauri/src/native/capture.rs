//! Windows GPU capture boundary.
//!
//! The concrete backend owns DXGI Desktop Duplication textures. Encoders receive
//! an `ID3D11Texture2D` directly; this API deliberately has no CPU byte buffer.
#[cfg(target_os = "windows")]
use super::{CaptureTargetId, CaptureTargetInfo};
#[cfg(target_os = "windows")]
use windows::{
    core::Interface,
    Win32::{
        Foundation::HMODULE,
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
                ID3D11Texture2D, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
            },
            Dxgi::{
                CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIOutput1,
                IDXGIOutputDuplication, IDXGIResource, DXGI_OUTDUPL_FRAME_INFO,
            },
        },
    },
};

#[cfg(target_os = "windows")]
pub struct DxgiCapture {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub duplication: IDXGIOutputDuplication,
}

#[cfg(target_os = "windows")]
pub struct GpuFrame<'a> {
    pub texture: ID3D11Texture2D,
    pub timestamp_qpc: i64,
    duplication: &'a IDXGIOutputDuplication,
}

#[cfg(target_os = "windows")]
impl Drop for GpuFrame<'_> {
    fn drop(&mut self) {
        unsafe {
            let _ = self.duplication.ReleaseFrame();
        }
    }
}

#[cfg(target_os = "windows")]
impl DxgiCapture {
    pub fn open(selected: Option<CaptureTargetId>) -> Result<Self, String> {
        unsafe {
            let factory: IDXGIFactory1 =
                CreateDXGIFactory1().map_err(|e| format!("DXGI factory: {e}"))?;
            let targets = enumerate_targets()?;
            let selected = selected
                .or_else(|| targets.iter().find(|item| item.primary).map(|item| item.id))
                .or_else(|| targets.first().map(|item| item.id))
                .ok_or("Nenhum monitor conectado foi encontrado")?;
            let adapter: IDXGIAdapter = factory
                .EnumAdapters(selected.adapter_index)
                .map_err(|e| format!("GPU selecionada: {e}"))?;
            let output: IDXGIOutput1 = adapter
                .EnumOutputs(selected.output_index)
                .and_then(|o| o.cast())
                .map_err(|e| format!("Monitor selecionado: {e}"))?;
            let mut device = None;
            let mut context = None;
            let levels = [D3D_FEATURE_LEVEL_11_0];
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|e| format!("D3D11: {e}"))?;
            let device = device.ok_or("D3D11 não retornou dispositivo")?;
            let context = context.ok_or("D3D11 não retornou contexto")?;
            let multithread: ID3D11Multithread = device
                .cast()
                .map_err(|e| format!("Proteção multithread D3D11: {e}"))?;
            let _ = multithread.SetMultithreadProtected(true);
            let duplication = output
                .DuplicateOutput(&device)
                .map_err(|e| format!("Desktop Duplication: {e}"))?;
            Ok(Self {
                device,
                context,
                duplication,
            })
        }
    }

    /// Returns the desktop texture without mapping it into system memory.
    /// NVENC/AMF/QSV backends must register this texture directly.
    pub fn acquire(&self, timeout_ms: u32) -> Result<Option<GpuFrame<'_>>, String> {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            match self
                .duplication
                .AcquireNextFrame(timeout_ms, &mut info, &mut resource)
            {
                Ok(()) => {
                    let texture = resource
                        .ok_or("DXGI não retornou textura")?
                        .cast::<ID3D11Texture2D>()
                        .map_err(|e| e.to_string())?;
                    Ok(Some(GpuFrame {
                        texture,
                        timestamp_qpc: info.LastPresentTime,
                        duplication: &self.duplication,
                    }))
                }
                Err(error) if error.code().0 as u32 == 0x887A0027 => Ok(None),
                Err(error) => Err(format!("Falha na captura DXGI: {error}")),
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn enumerate_targets() -> Result<Vec<CaptureTargetInfo>, String> {
    unsafe {
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|e| format!("DXGI factory: {e}"))?;
        let mut targets = Vec::new();
        for adapter_index in 0..32 {
            let Ok(adapter) = factory.EnumAdapters(adapter_index) else {
                break;
            };
            let adapter_desc = adapter
                .GetDesc()
                .map_err(|e| format!("Descrição da GPU: {e}"))?;
            let gpu = wide_string(&adapter_desc.Description);
            for output_index in 0..32 {
                let Ok(output) = adapter.EnumOutputs(output_index) else {
                    break;
                };
                let desc = output
                    .GetDesc()
                    .map_err(|e| format!("Descrição do monitor: {e}"))?;
                if !desc.AttachedToDesktop.as_bool() {
                    continue;
                }
                let rect = desc.DesktopCoordinates;
                targets.push(CaptureTargetInfo {
                    id: CaptureTargetId {
                        adapter_index,
                        output_index,
                    },
                    gpu: gpu.clone(),
                    monitor: wide_string(&desc.DeviceName),
                    width: (rect.right - rect.left).max(0) as u32,
                    height: (rect.bottom - rect.top).max(0) as u32,
                    primary: rect.left == 0 && rect.top == 0,
                });
            }
        }
        if targets.is_empty() {
            Err("Nenhum monitor conectado foi encontrado".into())
        } else {
            targets.sort_by_key(|target| !target.primary);
            Ok(targets)
        }
    }
}

#[cfg(target_os = "windows")]
fn wide_string<const N: usize>(value: &[u16; N]) -> String {
    let length = value.iter().position(|unit| *unit == 0).unwrap_or(N);
    String::from_utf16_lossy(&value[..length])
}

#[cfg(target_os = "windows")]
pub fn probe(target: Option<CaptureTargetId>) -> Result<(), String> {
    let capture = DxgiCapture::open(target)?;
    let _gpu_handles = (&capture.device, &capture.context);
    if let Some(frame) = capture.acquire(0)? {
        let _gpu_frame = (&frame.texture, frame.timestamp_qpc);
    }
    Ok(())
}
