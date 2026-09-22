//! D3D11 presenter for the separate native stream window.

use std::mem::ManuallyDrop;
use windows::{
    core::Interface,
    Win32::{
        Foundation::{HWND, RECT},
        Graphics::{
            Direct3D11::{
                ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext,
                ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
                ID3D11VideoProcessorOutputView, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV,
                D3D11_VIDEO_COLOR, D3D11_VIDEO_COLOR_0, D3D11_VIDEO_COLOR_RGBA,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
                D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
                D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
                D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
                D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
            },
            Dxgi::{
                Common::{
                    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_UNKNOWN,
                    DXGI_RATIONAL, DXGI_SAMPLE_DESC,
                },
                IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, DXGI_PRESENT, DXGI_SCALING_STRETCH,
                DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_DISCARD,
                DXGI_USAGE_RENDER_TARGET_OUTPUT,
            },
        },
        UI::WindowsAndMessaging::GetClientRect,
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
}

impl NativePresenter {
    pub fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        hwnd: HWND,
        width: u32,
        height: u32,
        fps: u32,
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
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
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
            })
        }
    }

    pub fn present(&mut self, nv12: &ID3D11Texture2D) -> Result<(), String> {
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
                        ArraySlice: 0,
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
        self.output_width = width;
        self.output_height = height;
        Ok(true)
    }
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
                top: 219,
                right: 1000,
                bottom: 781
            }
        );
    }
}
