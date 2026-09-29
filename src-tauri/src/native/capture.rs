//! Windows GPU capture boundary.
//!
//! The concrete backend owns DXGI Desktop Duplication textures. Encoders receive
//! an `ID3D11Texture2D` directly; this API deliberately has no CPU byte buffer.
#[cfg(target_os = "windows")]
use super::{
    transport::{CursorPacket, CursorShape},
    CaptureTargetId, CaptureTargetInfo, GraphicsAdapterInfo,
};
#[cfg(target_os = "windows")]
use voxa_native_core::protocol::Hdr10Metadata;
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
                Common::{
                    DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020, DXGI_FORMAT_B8G8R8A8_UNORM,
                    DXGI_FORMAT_R16G16B16A16_FLOAT,
                },
                CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIOutput1, IDXGIOutput5,
                IDXGIOutput6, IDXGIOutputDuplication, IDXGIResource, DXGI_OUTDUPL_FRAME_INFO,
                DXGI_OUTDUPL_POINTER_SHAPE_INFO, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR,
                DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR,
                DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME,
            },
        },
    },
};

#[cfg(target_os = "windows")]
pub struct DxgiCapture {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub duplication: IDXGIOutputDuplication,
    pub hdr: bool,
    pub hdr10: Option<Hdr10Metadata>,
    origin_x: i32,
    origin_y: i32,
    pub(super) width: u32,
    pub(super) height: u32,
}

#[cfg(target_os = "windows")]
pub struct GpuFrame<'a> {
    pub texture: ID3D11Texture2D,
    pub cursor_visible: bool,
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub source_width: u32,
    pub source_height: u32,
    pub cursor_shape_changed: bool,
    pub cursor_shape: Option<CursorShape>,
    _lease: FrameLease<'a>,
}

#[cfg(target_os = "windows")]
struct FrameLease<'a>(&'a IDXGIOutputDuplication);

#[cfg(target_os = "windows")]
impl Drop for FrameLease<'_> {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.ReleaseFrame();
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
            let output_desc = output
                .GetDesc()
                .map_err(|e| format!("Descrição do monitor selecionado: {e}"))?;
            let output6: Option<IDXGIOutput6> = output.cast().ok();
            let output_desc1 = output6
                .as_ref()
                .and_then(|output| output.GetDesc1().ok())
                .filter(|desc| desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020);
            let hdr10 = output_desc1.map(hdr10_metadata);
            let hdr = hdr10.is_some();
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
            if !multithread.SetMultithreadProtected(true).as_bool() {
                return Err("Driver recusou a protecao multithread D3D11 da captura".into());
            }
            let duplication = if let Ok(output5) = output.cast::<IDXGIOutput5>() {
                let formats = if hdr {
                    [DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_B8G8R8A8_UNORM]
                } else {
                    [DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT]
                };
                output5.DuplicateOutput1(&device, 0, &formats)
            } else {
                output.DuplicateOutput(&device)
            }
            .map_err(|e| format!("Desktop Duplication: {e}"))?;
            let rect = output_desc.DesktopCoordinates;
            Ok(Self {
                device,
                context,
                duplication,
                hdr,
                hdr10,
                origin_x: rect.left,
                origin_y: rect.top,
                width: (rect.right - rect.left).max(0) as u32,
                height: (rect.bottom - rect.top).max(0) as u32,
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
                    // A duplicacao exige exatamente um ReleaseFrame para toda
                    // aquisicao bem-sucedida, inclusive quando o recurso veio
                    // ausente ou o cast falha. O lease cobre todos os retornos.
                    let lease = FrameLease(&self.duplication);
                    let texture = resource
                        .ok_or("DXGI não retornou textura")?
                        .cast::<ID3D11Texture2D>()
                        .map_err(|e| e.to_string())?;
                    let cursor_shape_changed = info.PointerShapeBufferSize > 0;
                    let cursor_shape = if cursor_shape_changed {
                        self.pointer_shape(
                            info.PointerShapeBufferSize,
                            info.LastMouseUpdateTime.max(0) as u64,
                        )?
                    } else {
                        None
                    };
                    Ok(Some(GpuFrame {
                        texture,
                        cursor_visible: info.PointerPosition.Visible.as_bool(),
                        cursor_x: info.PointerPosition.Position.x - self.origin_x,
                        cursor_y: info.PointerPosition.Position.y - self.origin_y,
                        source_width: self.width,
                        source_height: self.height,
                        cursor_shape_changed,
                        cursor_shape,
                        _lease: lease,
                    }))
                }
                Err(error) if error.code().0 as u32 == 0x887A0027 => Ok(None),
                Err(error) => Err(format!("Falha na captura DXGI: {error}")),
            }
        }
    }

    fn pointer_shape(&self, requested: u32, id: u64) -> Result<Option<CursorShape>, String> {
        if requested == 0 || requested as usize > CursorPacket::MAX_SHAPE_BYTES {
            return Ok(None);
        }
        let mut bytes = vec![0u8; requested as usize];
        let mut required = 0u32;
        let mut info = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
        unsafe {
            self.duplication
                .GetFramePointerShape(
                    requested,
                    bytes.as_mut_ptr().cast(),
                    &mut required,
                    &mut info,
                )
                .map_err(|error| format!("Forma do cursor DXGI: {error}"))?;
        }
        let kind = match info.Type as i32 {
            value if value == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 => 1,
            value if value == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 => 2,
            value if value == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR.0 => 4,
            _ => return Ok(None),
        };
        let valid_height = if kind == 1 {
            info.Height <= 128
        } else {
            info.Height <= 64
        };
        if required == 0
            || required as usize > bytes.len()
            || required as usize > CursorPacket::MAX_SHAPE_BYTES
            || info.Width == 0
            || info.Width > 64
            || info.Height == 0
            || !valid_height
            || info.Pitch == 0
        {
            return Ok(None);
        }
        bytes.truncate(required as usize);
        let id = bytes.iter().fold(
            id ^ u64::from(info.Type) ^ (u64::from(info.Width) << 32) ^ u64::from(info.Height),
            |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3),
        );
        Ok(Some(CursorShape {
            id,
            kind,
            width: info.Width as u16,
            height: info.Height as u16,
            pitch: info.Pitch.min(u16::MAX.into()) as u16,
            hotspot_x: info.HotSpot.x.clamp(0, u16::MAX.into()) as u16,
            hotspot_y: info.HotSpot.y.clamp(0, u16::MAX.into()) as u16,
            bytes: std::sync::Arc::new(bytes),
        }))
    }
}

#[cfg(target_os = "windows")]
fn hdr10_metadata(desc: windows::Win32::Graphics::Dxgi::DXGI_OUTPUT_DESC1) -> Hdr10Metadata {
    let chromaticity = |value: [f32; 2]| {
        value.map(|component| (component.clamp(0.0, 1.0) * 50_000.0).round() as u16)
    };
    let max_nits = desc.MaxLuminance.clamp(1.0, u16::MAX as f32).round() as u16;
    let average_nits = desc
        .MaxFullFrameLuminance
        .clamp(1.0, u16::MAX as f32)
        .round() as u16;
    Hdr10Metadata {
        red_primary: chromaticity(desc.RedPrimary),
        green_primary: chromaticity(desc.GreenPrimary),
        blue_primary: chromaticity(desc.BluePrimary),
        white_point: chromaticity(desc.WhitePoint),
        max_mastering_luminance: (desc.MaxLuminance.max(1.0) * 10_000.0).round() as u32,
        min_mastering_luminance: (desc.MinLuminance.max(0.0) * 10_000.0).round() as u32,
        max_content_light_level: max_nits,
        max_frame_average_light_level: average_nits,
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
                    hdr: output
                        .cast::<IDXGIOutput6>()
                        .ok()
                        .and_then(|output| output.GetDesc1().ok())
                        .is_some_and(|desc| {
                            desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020
                        }),
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
pub fn enumerate_adapters() -> Result<Vec<GraphicsAdapterInfo>, String> {
    unsafe {
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|e| format!("DXGI factory: {e}"))?;
        let mut adapters = Vec::new();
        for adapter_index in 0..32 {
            let Ok(adapter) = factory.EnumAdapters(adapter_index) else {
                break;
            };
            let desc = adapter
                .GetDesc()
                .map_err(|e| format!("Descrição da GPU: {e}"))?;
            let driver_version = adapter
                .CheckInterfaceSupport(&ID3D11Device::IID)
                .ok()
                .map(format_driver_version);
            adapters.push(GraphicsAdapterInfo {
                adapter_index,
                name: wide_string(&desc.Description),
                dedicated_memory_mb: desc.DedicatedVideoMemory as u64 / (1024 * 1024),
                vendor_id: desc.VendorId,
                device_id: desc.DeviceId,
                revision: desc.Revision,
                driver_version,
            });
        }
        if adapters.is_empty() {
            Err("Nenhuma GPU D3D11 foi encontrada".into())
        } else {
            Ok(adapters)
        }
    }
}

#[cfg(target_os = "windows")]
fn wide_string<const N: usize>(value: &[u16; N]) -> String {
    let length = value.iter().position(|unit| *unit == 0).unwrap_or(N);
    String::from_utf16_lossy(&value[..length])
}

#[cfg(target_os = "windows")]
fn format_driver_version(value: i64) -> String {
    let value = value as u64;
    format!(
        "{}.{}.{}.{}",
        (value >> 48) & 0xffff,
        (value >> 32) & 0xffff,
        (value >> 16) & 0xffff,
        value & 0xffff
    )
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::format_driver_version;

    #[test]
    fn formats_dxgi_driver_version_components() {
        let packed = ((31u64 << 48) | (15u64 << 16) | 5171u64) as i64;
        assert_eq!(format_driver_version(packed), "31.0.15.5171");
    }
}
