//! D3D11 presenter for the separate native stream window.

use std::mem::ManuallyDrop;
use voxa_native_core::protocol::Hdr10Metadata;
use windows::{
    core::Interface,
    Win32::{
        Foundation::{HWND, RECT},
        Graphics::{
            Direct3D11::{
                ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext,
                ID3D11VideoContext1, ID3D11VideoDevice, ID3D11VideoProcessor,
                ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorOutputView, D3D11_TEX2D_VPIV,
                D3D11_TEX2D_VPOV, D3D11_VIDEO_COLOR, D3D11_VIDEO_COLOR_0, D3D11_VIDEO_COLOR_RGBA,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
                D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
                D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
                D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
                D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
            },
            Dxgi::{
                Common::{
                    DXGI_ALPHA_MODE_IGNORE, DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020,
                    DXGI_COLOR_SPACE_YCBCR_STUDIO_G2084_LEFT_P2020, DXGI_FORMAT_B8G8R8A8_UNORM,
                    DXGI_FORMAT_R10G10B10A2_UNORM, DXGI_FORMAT_UNKNOWN, DXGI_RATIONAL,
                    DXGI_SAMPLE_DESC,
                },
                IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, IDXGISwapChain3, IDXGISwapChain4,
                DXGI_HDR_METADATA_HDR10, DXGI_HDR_METADATA_TYPE_HDR10, DXGI_PRESENT,
                DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_COLOR_SPACE_SUPPORT_FLAG_PRESENT,
                DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_DISCARD,
                DXGI_USAGE_RENDER_TARGET_OUTPUT,
            },
            Gdi::{CreateBitmap, DeleteObject, GetDC, ReleaseDC, HBITMAP},
        },
        UI::WindowsAndMessaging::{
            CreateIconIndirect, DestroyIcon, DrawIconEx, GetClientRect, LoadCursorW, DI_NORMAL,
            HICON, ICONINFO, IDC_ARROW,
        },
    },
};

pub struct NativePresenter {
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    swap_chain: IDXGISwapChain1,
    hwnd: HWND,
    source_width: u32,
    source_height: u32,
    fps: u32,
    output_width: u32,
    output_height: u32,
    hdr10: Option<Hdr10Metadata>,
    cursor_icon: Option<CachedCursorIcon>,
}

struct CachedCursorIcon {
    id: u64,
    handle: HICON,
}

impl Drop for CachedCursorIcon {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyIcon(self.handle);
        }
    }
}

impl NativePresenter {
    pub fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        hwnd: HWND,
        width: u32,
        height: u32,
        fps: u32,
        hdr10: Option<Hdr10Metadata>,
    ) -> Result<Self, String> {
        unsafe {
            let dxgi_device: IDXGIDevice = device.cast().map_err(|e| e.to_string())?;
            let adapter = dxgi_device
                .GetAdapter()
                .map_err(|e| format!("Adapter DXGI do decoder: {e}"))?;
            let factory: IDXGIFactory2 = adapter
                .GetParent()
                .map_err(|e| format!("Factory DXGI do decoder: {e}"))?;
            let desc = DXGI_SWAP_CHAIN_DESC1 {
                Width: width,
                Height: height,
                Format: if hdr10.is_some() {
                    DXGI_FORMAT_R10G10B10A2_UNORM
                } else {
                    DXGI_FORMAT_B8G8R8A8_UNORM
                },
                Stereo: false.into(),
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                BufferCount: 2,
                Scaling: DXGI_SCALING_STRETCH,
                SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
                AlphaMode: DXGI_ALPHA_MODE_IGNORE,
                Flags: 0,
            };
            let swap_chain = factory
                .CreateSwapChainForHwnd(device, hwnd, &desc, None, None)
                .map_err(|e| format!("Swapchain D3D11: {e}"))?;
            let video_device: ID3D11VideoDevice = device.cast().map_err(|e| e.to_string())?;
            let video_context: ID3D11VideoContext = context.cast().map_err(|e| e.to_string())?;
            let rate = DXGI_RATIONAL {
                Numerator: fps,
                Denominator: 1,
            };
            let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: width,
                InputHeight: height,
                OutputFrameRate: rate,
                OutputWidth: width,
                OutputHeight: height,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let enumerator = video_device
                .CreateVideoProcessorEnumerator(&content)
                .map_err(|e| format!("Video processor do presenter: {e}"))?;
            let processor = video_device
                .CreateVideoProcessor(&enumerator, 0)
                .map_err(|e| format!("Conversor NV12/BGRA: {e}"))?;
            configure_video_color_space(&video_context, &processor, hdr10.is_some())?;
            configure_swap_chain_hdr(&swap_chain, hdr10)?;
            Ok(Self {
                video_device,
                video_context,
                enumerator,
                processor,
                swap_chain,
                hwnd,
                source_width: width,
                source_height: height,
                fps,
                output_width: width,
                output_height: height,
                hdr10,
                cursor_icon: None,
            })
        }
    }

    pub fn present(
        &mut self,
        nv12: &ID3D11Texture2D,
        subresource_index: u32,
    ) -> Result<(), String> {
        unsafe {
            if !self.resize_if_needed()? {
                return Ok(());
            }
            let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPIV {
                        MipSlice: 0,
                        ArraySlice: subresource_index,
                    },
                },
            };
            let mut input_view = None;
            self.video_device
                .CreateVideoProcessorInputView(
                    nv12,
                    &self.enumerator,
                    &input_desc,
                    Some(&mut input_view),
                )
                .map_err(|e| format!("Entrada NV12 do presenter: {e}"))?;
            let back_buffer: ID3D11Texture2D = self
                .swap_chain
                .GetBuffer(0)
                .map_err(|e| format!("Backbuffer D3D11: {e}"))?;
            let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut output_view: Option<ID3D11VideoProcessorOutputView> = None;
            self.video_device
                .CreateVideoProcessorOutputView(
                    &back_buffer,
                    &self.enumerator,
                    &output_desc,
                    Some(&mut output_view),
                )
                .map_err(|e| format!("Saída BGRA do presenter: {e}"))?;
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(input_view),
                ..Default::default()
            };
            let destination = letterbox(
                self.source_width,
                self.source_height,
                self.output_width,
                self.output_height,
            );
            self.video_context.VideoProcessorSetStreamDestRect(
                &self.processor,
                0,
                true,
                Some(&destination),
            );
            let black = D3D11_VIDEO_COLOR {
                Anonymous: D3D11_VIDEO_COLOR_0 {
                    RGBA: D3D11_VIDEO_COLOR_RGBA {
                        R: 0.0,
                        G: 0.0,
                        B: 0.0,
                        A: 1.0,
                    },
                },
            };
            self.video_context.VideoProcessorSetOutputBackgroundColor(
                &self.processor,
                false,
                &black,
            );
            self.video_context
                .VideoProcessorBlt(
                    &self.processor,
                    &output_view.ok_or("Presenter não retornou output view")?,
                    0,
                    &[stream],
                )
                .map_err(|e| format!("Composição do frame: {e}"))?;
            self.swap_chain
                .Present(0, DXGI_PRESENT(0))
                .ok()
                .map_err(|e| format!("Apresentação do frame: {e}"))
        }
    }

    pub fn present_cursor(
        &mut self,
        cursor: &super::transport::CursorPacket,
    ) -> Result<(), String> {
        if !cursor.visible || cursor.source_width == 0 || cursor.source_height == 0 {
            return Ok(());
        }
        let destination = letterbox(
            cursor.source_width,
            cursor.source_height,
            self.output_width,
            self.output_height,
        );
        let width = (destination.right - destination.left).max(1);
        let height = (destination.bottom - destination.top).max(1);
        let x = destination.left
            + (i64::from(cursor.x).clamp(0, i64::from(cursor.source_width)) * i64::from(width)
                / i64::from(cursor.source_width)) as i32;
        let y = destination.top
            + (i64::from(cursor.y).clamp(0, i64::from(cursor.source_height)) * i64::from(height)
                / i64::from(cursor.source_height)) as i32;
        unsafe {
            let icon = self.cursor_handle(cursor)?;
            let dc = GetDC(Some(self.hwnd));
            if dc.is_invalid() {
                return Err("Não foi possível desenhar o cursor remoto".into());
            }
            let drawn = DrawIconEx(dc, x, y, icon, 0, 0, 0, None, DI_NORMAL).is_ok();
            let _ = ReleaseDC(Some(self.hwnd), dc);
            if drawn {
                Ok(())
            } else {
                Err("Falha ao desenhar o cursor remoto".into())
            }
        }
    }

    fn cursor_handle(&mut self, cursor: &super::transport::CursorPacket) -> Result<HICON, String> {
        if let Some(shape) = &cursor.shape {
            if self.cursor_icon.as_ref().map(|icon| icon.id) != Some(shape.id) {
                self.cursor_icon = create_cursor_icon(shape).map(|handle| CachedCursorIcon {
                    id: shape.id,
                    handle,
                });
            }
            if let Some(icon) = &self.cursor_icon {
                return Ok(icon.handle);
            }
        } else {
            self.cursor_icon = None;
        }
        unsafe { LoadCursorW(None, IDC_ARROW) }
            .map(Into::into)
            .map_err(|error| format!("Cursor padrão do Windows: {error}"))
    }

    unsafe fn resize_if_needed(&mut self) -> Result<bool, String> {
        let mut client = RECT::default();
        unsafe { GetClientRect(self.hwnd, &mut client) }
            .map_err(|e| format!("Tamanho da janela nativa: {e}"))?;
        let width = (client.right - client.left).max(0) as u32;
        let height = (client.bottom - client.top).max(0) as u32;
        if width == 0 || height == 0 {
            return Ok(false);
        }
        if width == self.output_width && height == self.output_height {
            return Ok(true);
        }
        unsafe {
            self.swap_chain
                .ResizeBuffers(
                    0,
                    width,
                    height,
                    DXGI_FORMAT_UNKNOWN,
                    DXGI_SWAP_CHAIN_FLAG(0),
                )
                .map_err(|e| format!("ResizeBuffers D3D11 (device lost possível): {e}"))?;
        }
        let rate = DXGI_RATIONAL {
            Numerator: self.fps,
            Denominator: 1,
        };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: self.source_width,
            InputHeight: self.source_height,
            OutputFrameRate: rate,
            OutputWidth: width,
            OutputHeight: height,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        self.enumerator = unsafe { self.video_device.CreateVideoProcessorEnumerator(&content) }
            .map_err(|e| format!("Video processor após resize: {e}"))?;
        self.processor = unsafe { self.video_device.CreateVideoProcessor(&self.enumerator, 0) }
            .map_err(|e| format!("Conversor após resize: {e}"))?;
        configure_video_color_space(&self.video_context, &self.processor, self.hdr10.is_some())?;
        configure_swap_chain_hdr(&self.swap_chain, self.hdr10)?;
        self.output_width = width;
        self.output_height = height;
        Ok(true)
    }
}

fn create_cursor_icon(shape: &super::transport::CursorShape) -> Option<HICON> {
    let width = i32::from(shape.width);
    let height = i32::from(shape.height);
    if width <= 0 || height <= 0 || shape.bytes.is_empty() {
        return None;
    }
    unsafe {
        let (mask, color) = match shape.kind {
            1 => {
                let expected = usize::from(shape.pitch).checked_mul(usize::from(shape.height))?;
                if shape.bytes.len() != expected {
                    return None;
                }
                (
                    CreateBitmap(width, height, 1, 1, Some(shape.bytes.as_ptr().cast())),
                    HBITMAP::default(),
                )
            }
            2 => {
                let row_bytes = usize::from(shape.width).checked_mul(4)?;
                let pitch = usize::from(shape.pitch);
                let expected = pitch.checked_mul(usize::from(shape.height))?;
                if pitch < row_bytes || shape.bytes.len() != expected {
                    return None;
                }
                let mut pixels = Vec::with_capacity(row_bytes * usize::from(shape.height));
                for row in shape.bytes.chunks_exact(pitch) {
                    pixels.extend_from_slice(&row[..row_bytes]);
                }
                let color = CreateBitmap(width, height, 1, 32, Some(pixels.as_ptr().cast()));
                let mask_row = usize::from(shape.width).div_ceil(16) * 2;
                let mask_bits = vec![0u8; mask_row * usize::from(shape.height)];
                let mask = CreateBitmap(width, height, 1, 1, Some(mask_bits.as_ptr().cast()));
                (mask, color)
            }
            // Masked-color exige XOR com o pixel existente. Aproximar com
            // alpha altera as cores; nesses cursores usamos a seta segura.
            _ => return None,
        };
        if mask.is_invalid() || (shape.kind == 2 && color.is_invalid()) {
            if !mask.is_invalid() {
                let _ = DeleteObject(mask.into());
            }
            if !color.is_invalid() {
                let _ = DeleteObject(color.into());
            }
            return None;
        }
        let info = ICONINFO {
            // DrawIconEx recebe a coordenada do canto superior esquerdo
            // informada pelo DXGI; criar HICON tambem permite DestroyIcon.
            fIcon: true.into(),
            xHotspot: u32::from(shape.hotspot_x),
            yHotspot: u32::from(shape.hotspot_y),
            hbmMask: mask,
            hbmColor: color,
        };
        let icon = CreateIconIndirect(&info).ok();
        let _ = DeleteObject(mask.into());
        if !color.is_invalid() {
            let _ = DeleteObject(color.into());
        }
        icon
    }
}

fn configure_video_color_space(
    context: &ID3D11VideoContext,
    processor: &ID3D11VideoProcessor,
    hdr10: bool,
) -> Result<(), String> {
    if !hdr10 {
        return Ok(());
    }
    let context1: ID3D11VideoContext1 = context
        .cast()
        .map_err(|e| format!("Video processor do espectador sem HDR10: {e}"))?;
    unsafe {
        context1.VideoProcessorSetStreamColorSpace1(
            processor,
            0,
            DXGI_COLOR_SPACE_YCBCR_STUDIO_G2084_LEFT_P2020,
        );
        context1.VideoProcessorSetOutputColorSpace1(
            processor,
            DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020,
        );
    }
    Ok(())
}

fn configure_swap_chain_hdr(
    swap_chain: &IDXGISwapChain1,
    metadata: Option<Hdr10Metadata>,
) -> Result<(), String> {
    let Some(metadata) = metadata else {
        return Ok(());
    };
    let chain3: IDXGISwapChain3 = swap_chain
        .cast()
        .map_err(|e| format!("Swapchain sem suporte a espaço de cor HDR10: {e}"))?;
    let chain4: IDXGISwapChain4 = swap_chain
        .cast()
        .map_err(|e| format!("Swapchain sem suporte a metadata HDR10: {e}"))?;
    unsafe {
        let support = chain3
            .CheckColorSpaceSupport(DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020)
            .map_err(|e| format!("Consulta de HDR10 da tela: {e}"))?;
        if support & DXGI_SWAP_CHAIN_COLOR_SPACE_SUPPORT_FLAG_PRESENT.0 as u32 == 0 {
            return Err("A tela selecionada não aceita apresentação HDR10".into());
        }
        chain3
            .SetColorSpace1(DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020)
            .map_err(|e| format!("Espaço de cor HDR10 da swapchain: {e}"))?;
        let native = DXGI_HDR_METADATA_HDR10 {
            RedPrimary: metadata.red_primary,
            GreenPrimary: metadata.green_primary,
            BluePrimary: metadata.blue_primary,
            WhitePoint: metadata.white_point,
            MaxMasteringLuminance: metadata.max_mastering_luminance,
            MinMasteringLuminance: metadata.min_mastering_luminance,
            MaxContentLightLevel: metadata.max_content_light_level,
            MaxFrameAverageLightLevel: metadata.max_frame_average_light_level,
        };
        let bytes = std::slice::from_raw_parts(
            (&native as *const DXGI_HDR_METADATA_HDR10).cast::<u8>(),
            std::mem::size_of::<DXGI_HDR_METADATA_HDR10>(),
        );
        chain4
            .SetHDRMetaData(DXGI_HDR_METADATA_TYPE_HDR10, Some(bytes))
            .map_err(|e| format!("Metadata HDR10 da swapchain: {e}"))?;
    }
    Ok(())
}

fn letterbox(source_width: u32, source_height: u32, output_width: u32, output_height: u32) -> RECT {
    let source_aspect = source_width as f64 / source_height as f64;
    let output_aspect = output_width as f64 / output_height as f64;
    let (width, height) = if output_aspect > source_aspect {
        (
            (output_height as f64 * source_aspect).round() as i32,
            output_height as i32,
        )
    } else {
        (
            output_width as i32,
            (output_width as f64 / source_aspect).round() as i32,
        )
    };
    let left = (output_width as i32 - width) / 2;
    let top = (output_height as i32 - height) / 2;
    RECT {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letterboxes_wide_video_in_square_window() {
        assert_eq!(
            letterbox(1920, 1080, 1000, 1000),
            RECT {
                left: 0,
                // 1000 * 9 / 16 = 562.5. Arredondar para 563 preserva
                // melhor a proporcao; o pixel impar restante fica embaixo.
                top: 218,
                right: 1000,
                bottom: 781
            }
        );
    }
}
