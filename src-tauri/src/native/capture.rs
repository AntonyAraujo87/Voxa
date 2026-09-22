//! Windows GPU capture boundary.
//!
//! The concrete backend owns DXGI Desktop Duplication textures. Encoders receive
//! an `ID3D11Texture2D` directly; this API deliberately has no CPU byte buffer.
#[cfg(target_os = "windows")]
use windows::{
    core::Interface,
    Win32::{
        Foundation::HMODULE,
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
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
    pub fn primary() -> Result<Self, String> {
        unsafe {
            let factory: IDXGIFactory1 =
                CreateDXGIFactory1().map_err(|e| format!("DXGI factory: {e}"))?;
            let adapter: IDXGIAdapter = factory
                .EnumAdapters(0)
                .map_err(|e| format!("GPU primária: {e}"))?;
            let output: IDXGIOutput1 = adapter
                .EnumOutputs(0)
                .and_then(|o| o.cast())
                .map_err(|e| format!("Saída primária: {e}"))?;
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
pub fn probe() -> Result<(), String> {
    let capture = DxgiCapture::primary()?;
    let _gpu_handles = (&capture.device, &capture.context);
    if let Some(frame) = capture.acquire(0)? {
        let _gpu_frame = (&frame.texture, frame.timestamp_qpc);
    }
    Ok(())
}
