//! GPU-only RGB -> NV12/P010 conversion using the D3D11 video processor.

use std::mem::ManuallyDrop;
use windows::{
    core::Interface,
    Win32::Graphics::{
        Direct3D11::{
            ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext,
            ID3D11VideoContext1, ID3D11VideoDevice, ID3D11VideoProcessor,
            ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorOutputView,
            D3D11_BIND_RENDER_TARGET, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC,
            D3D11_USAGE_DEFAULT, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
            D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
            D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
            D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D,
            D3D11_VPOV_DIMENSION_TEXTURE2D,
        },
        Dxgi::Common::{
            DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020,
            DXGI_COLOR_SPACE_YCBCR_STUDIO_G2084_LEFT_P2020, DXGI_FORMAT_NV12, DXGI_FORMAT_P010,
            DXGI_RATIONAL, DXGI_SAMPLE_DESC,
        },
    },
};

pub struct GpuColorConverter {
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    output: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
}

#[derive(Clone, Copy)]
pub struct ConversionSpec {
    pub input_width: u32,
    pub input_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub fps: u32,
    pub hdr10: bool,
}

impl GpuColorConverter {
    pub fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        spec: ConversionSpec,
    ) -> Result<Self, String> {
        let ConversionSpec {
            input_width,
            input_height,
            output_width,
            output_height,
            fps,
            hdr10,
        } = spec;
        unsafe {
            let video_device: ID3D11VideoDevice = device.cast().map_err(|e| e.to_string())?;
            let video_context: ID3D11VideoContext = context.cast().map_err(|e| e.to_string())?;
            let rate = DXGI_RATIONAL {
                Numerator: fps,
                Denominator: 1,
            };
            let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: input_width,
                InputHeight: input_height,
                OutputFrameRate: rate,
                OutputWidth: output_width,
                OutputHeight: output_height,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let enumerator = video_device
                .CreateVideoProcessorEnumerator(&content)
                .map_err(|e| format!("Video processor: {e}"))?;
            let processor = video_device
                .CreateVideoProcessor(&enumerator, 0)
                .map_err(|e| format!("Conversor de cor: {e}"))?;
            if hdr10 {
                let context1: ID3D11VideoContext1 = context
                    .cast()
                    .map_err(|e| format!("Video processor sem suporte HDR10: {e}"))?;
                context1.VideoProcessorSetStreamColorSpace1(
                    &processor,
                    0,
                    DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020,
                );
                context1.VideoProcessorSetOutputColorSpace1(
                    &processor,
                    DXGI_COLOR_SPACE_YCBCR_STUDIO_G2084_LEFT_P2020,
                );
            }
            let texture_desc = D3D11_TEXTURE2D_DESC {
                Width: output_width,
                Height: output_height,
                MipLevels: 1,
                ArraySize: 1,
                Format: if hdr10 {
                    DXGI_FORMAT_P010
                } else {
                    DXGI_FORMAT_NV12
                },
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut output = None;
            device
                .CreateTexture2D(&texture_desc, None, Some(&mut output))
                .map_err(|e| format!("Textura NV12/P010: {e}"))?;
            let output = output.ok_or("D3D11 não retornou textura NV12/P010")?;
            let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut output_view = None;
            video_device
                .CreateVideoProcessorOutputView(
                    &output,
                    &enumerator,
                    &output_desc,
                    Some(&mut output_view),
                )
                .map_err(|e| format!("Saída NV12/P010: {e}"))?;
            Ok(Self {
                video_device,
                video_context,
                enumerator,
                processor,
                output,
                output_view: output_view.ok_or("D3D11 não retornou saída NV12/P010")?,
            })
        }
    }

    pub fn convert(&self, bgra: &ID3D11Texture2D) -> Result<ID3D11Texture2D, String> {
        unsafe {
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
                    bgra,
                    &self.enumerator,
                    &input_desc,
                    Some(&mut input_view),
                )
                .map_err(|e| format!("Entrada BGRA: {e}"))?;
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(input_view),
                ..Default::default()
            };
            self.video_context
                .VideoProcessorBlt(&self.processor, &self.output_view, 0, &[stream])
                .map_err(|e| format!("Conversão RGB/NV12-P010: {e}"))?;
            Ok(self.output.clone())
        }
    }
}
