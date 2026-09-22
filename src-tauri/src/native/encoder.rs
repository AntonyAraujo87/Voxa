//! Hardware-only H.264 encoder boundary backed by Windows Media Foundation.

use std::{ffi::c_void, mem::ManuallyDrop, ptr, slice};
use windows::{
    core::{Interface, GUID},
    Win32::{
        Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D},
        Media::MediaFoundation::{
            IMFActivate, IMFDXGIDeviceManager, IMFMediaEventGenerator, IMFMediaType, IMFTransform,
            METransformHaveOutput, METransformNeedInput, MFCreateDXGIDeviceManager,
            MFCreateDXGISurfaceBuffer, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
            MFMediaType_Video, MFSampleExtension_CleanPoint, MFShutdown, MFStartup, MFTEnumEx,
            MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFSTARTUP_LITE,
            MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER,
            MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_END_STREAMING,
            MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER,
            MFT_OUTPUT_DATA_BUFFER, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO,
            MF_EVENT_FLAG_NO_WAIT, MF_E_NO_EVENTS_AVAILABLE, MF_E_TRANSFORM_NEED_MORE_INPUT,
            MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
            MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK,
            MF_VERSION,
        },
        System::Com::CoTaskMemFree,
    },
};

struct MediaFoundation;
impl MediaFoundation {
    fn start() -> Result<Self, String> {
        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_LITE).map_err(|e| format!("Media Foundation: {e}"))?
        };
        Ok(Self)
    }
}
impl Drop for MediaFoundation {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
        }
    }
}

pub fn hardware_h264_encoder_count() -> Result<u32, String> {
    let _runtime = MediaFoundation::start()?;
    Ok(enumerate_h264()?.len() as u32)
}

fn enumerate_h264() -> Result<Vec<IMFActivate>, String> {
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut activates: *mut Option<IMFActivate> = ptr::null_mut();
    let mut count = 0;
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            Some(&output),
            &mut activates,
            &mut count,
        )
        .map_err(|e| format!("Enumeração de encoder H.264: {e}"))?;
        let mut encoders = Vec::with_capacity(count as usize);
        if !activates.is_null() {
            for activate in slice::from_raw_parts_mut(activates, count as usize) {
                if let Some(activate) = activate.take() {
                    encoders.push(activate);
                }
            }
            CoTaskMemFree(Some(activates.cast::<c_void>()));
        }
        Ok(encoders)
    }
}

/// Owns a hardware MFT configured for NV12 textures and an H.264 bitstream.
/// Raw desktop BGRA must be converted to an NV12 D3D11 texture before input.
#[expect(dead_code, reason = "ativado pelo ciclo de captura no próximo estágio")]
pub struct HardwareH264Encoder {
    transform: IMFTransform,
    manager: IMFDXGIDeviceManager,
    activation: IMFActivate,
    output_capacity: u32,
    events: Option<IMFMediaEventGenerator>,
    _runtime: MediaFoundation,
}

#[expect(dead_code, reason = "ativado pelo ciclo de captura no próximo estágio")]
impl HardwareH264Encoder {
    pub fn open(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
    ) -> Result<Self, String> {
        if width == 0
            || height == 0
            || !width.is_multiple_of(2)
            || !height.is_multiple_of(2)
            || fps == 0
        {
            return Err("Dimensões e FPS inválidos para H.264 NV12".into());
        }
        let runtime = MediaFoundation::start()?;
        let activation = enumerate_h264()?
            .into_iter()
            .next()
            .ok_or("Nenhum encoder H.264 por hardware disponível")?;
        unsafe {
            let transform: IMFTransform = activation
                .ActivateObject()
                .map_err(|e| format!("Ativação do encoder: {e}"))?;
            let attributes = transform
                .GetAttributes()
                .map_err(|e| format!("Atributos do encoder: {e}"))?;
            let asynchronous = attributes
                .GetUINT32(&MF_TRANSFORM_ASYNC)
                .unwrap_or_default()
                != 0;
            if asynchronous {
                attributes
                    .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                    .map_err(|e| format!("Desbloqueio do encoder assíncrono: {e}"))?;
            }
            let mut reset_token = 0;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut reset_token, &mut manager)
                .map_err(|e| format!("DXGI Device Manager: {e}"))?;
            let manager = manager.ok_or("Media Foundation não retornou o gerenciador DXGI")?;
            manager
                .ResetDevice(device, reset_token)
                .map_err(|e| format!("Registro da GPU no encoder: {e}"))?;
            transform
                .ProcessMessage(
                    MFT_MESSAGE_SET_D3D_MANAGER,
                    Interface::as_raw(&manager) as usize,
                )
                .map_err(|e| format!("Encoder recusou o gerenciador D3D11: {e}"))?;

            let output = media_type(MFVideoFormat_H264, width, height, fps, Some(bitrate))?;
            let input = media_type(MFVideoFormat_NV12, width, height, fps, None)?;
            transform
                .SetOutputType(0, &output, 0)
                .map_err(|e| format!("Formato H.264: {e}"))?;
            transform
                .SetInputType(0, &input, 0)
                .map_err(|e| format!("Formato NV12: {e}"))?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .and_then(|_| transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0))
                .map_err(|e| format!("Inicialização do encoder: {e}"))?;
            let stream = transform
                .GetOutputStreamInfo(0)
                .map_err(|e| format!("Buffer de saída H.264: {e}"))?;
            let events = if asynchronous {
                Some(
                    transform
                        .cast()
                        .map_err(|e| format!("Eventos do encoder: {e}"))?,
                )
            } else {
                None
            };
            Ok(Self {
                transform,
                manager,
                activation,
                output_capacity: stream.cbSize.max(width.saturating_mul(height)),
                events,
                _runtime: runtime,
            })
        }
    }

    pub fn transform(&self) -> &IMFTransform {
        &self.transform
    }
    pub fn device_manager(&self) -> &IMFDXGIDeviceManager {
        &self.manager
    }

    /// Alimenta uma textura NV12. Somente o bitstream comprimido é copiado
    /// para RAM; os pixels brutos continuam em recursos D3D11.
    pub fn encode(
        &self,
        nv12: &ID3D11Texture2D,
        timestamp_100ns: i64,
        duration_100ns: i64,
    ) -> Result<Option<EncodedAccessUnit>, String> {
        unsafe {
            if let Some(events) = &self.events {
                wait_for(events, METransformNeedInput.0 as u32)?;
            }
            let input_buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, nv12, 0, false)
                .map_err(|e| format!("Superfície NV12 do encoder: {e}"))?;
            let input = MFCreateSample().map_err(|e| e.to_string())?;
            input.AddBuffer(&input_buffer).map_err(|e| e.to_string())?;
            input
                .SetSampleTime(timestamp_100ns)
                .map_err(|e| e.to_string())?;
            input
                .SetSampleDuration(duration_100ns)
                .map_err(|e| e.to_string())?;
            self.transform
                .ProcessInput(0, &input, 0)
                .map_err(|e| format!("Entrada do encoder: {e}"))?;
            if let Some(events) = &self.events {
                wait_for(events, METransformHaveOutput.0 as u32)?;
            }

            let stream = self
                .transform
                .GetOutputStreamInfo(0)
                .map_err(|e| e.to_string())?;
            let supplied_sample =
                if stream.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
                    let buffer = MFCreateMemoryBuffer(self.output_capacity)
                        .map_err(|e| format!("Buffer H.264: {e}"))?;
                    let sample = MFCreateSample().map_err(|e| e.to_string())?;
                    sample.AddBuffer(&buffer).map_err(|e| e.to_string())?;
                    Some(sample)
                } else {
                    None
                };
            let mut output = MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(supplied_sample),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            };
            let mut status = 0;
            let result = self
                .transform
                .ProcessOutput(0, slice::from_mut(&mut output), &mut status);
            let sample = ManuallyDrop::take(&mut output.pSample);
            drop(ManuallyDrop::take(&mut output.pEvents));
            if let Err(error) = result {
                if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                    return Ok(None);
                }
                return Err(format!("Saída do encoder: {error}"));
            }
            let sample = sample.ok_or("Encoder não retornou amostra H.264")?;
            let keyframe = sample
                .GetUINT32(&MFSampleExtension_CleanPoint)
                .unwrap_or_default()
                != 0;
            let buffer = sample
                .ConvertToContiguousBuffer()
                .map_err(|e| format!("Bitstream H.264: {e}"))?;
            let length = buffer.GetCurrentLength().map_err(|e| e.to_string())? as usize;
            let mut pointer = ptr::null_mut();
            buffer
                .Lock(&mut pointer, None, None)
                .map_err(|e| e.to_string())?;
            let bytes = slice::from_raw_parts(pointer, length).to_vec();
            buffer.Unlock().map_err(|e| e.to_string())?;
            Ok(Some(EncodedAccessUnit { bytes, keyframe }))
        }
    }
}

pub struct EncodedAccessUnit {
    pub bytes: Vec<u8>,
    pub keyframe: bool,
}

unsafe fn wait_for(events: &IMFMediaEventGenerator, expected: u32) -> Result<(), String> {
    let started = std::time::Instant::now();
    loop {
        let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => event,
            Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => {
                if started.elapsed() >= std::time::Duration::from_millis(500) {
                    return Err("Encoder de hardware não respondeu em 500 ms".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
                continue;
            }
            Err(error) => return Err(format!("Evento do encoder: {error}")),
        };
        let status = unsafe { event.GetStatus() }.map_err(|e| e.to_string())?;
        status
            .ok()
            .map_err(|e| format!("Falha assíncrona do encoder: {e}"))?;
        if unsafe { event.GetType() }.map_err(|e| e.to_string())? == expected {
            return Ok(());
        }
    }
}

impl Drop for HardwareH264Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = self.activation.ShutdownObject();
        }
    }
}

unsafe fn media_type(
    subtype: GUID,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: Option<u32>,
) -> Result<IMFMediaType, String> {
    let media = unsafe { MFCreateMediaType().map_err(|e| e.to_string())? };
    unsafe {
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .and_then(|_| media.SetGUID(&MF_MT_SUBTYPE, &subtype))
            .and_then(|_| {
                media.SetUINT64(&MF_MT_FRAME_SIZE, ((width as u64) << 32) | height as u64)
            })
            .and_then(|_| media.SetUINT64(&MF_MT_FRAME_RATE, ((fps as u64) << 32) | 1))
            .and_then(|_| {
                media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            })
            .map_err(|e| format!("Tipo de mídia: {e}"))?;
        if let Some(bitrate) = bitrate {
            media
                .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
                .map_err(|e| format!("Bitrate H.264: {e}"))?;
        }
    }
    Ok(media)
}
