//! Hardware-only video decoder backed by Windows Media Foundation.

use std::{mem::ManuallyDrop, ptr, slice, time::Duration};
use voxa_native_core::protocol::VideoCodec;
use windows::{
    core::{Interface, GUID},
    Win32::{
        Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D},
        Media::MediaFoundation::{
            IMFActivate, IMFDXGIBuffer, IMFDXGIDeviceManager, IMFMediaEventGenerator, IMFMediaType,
            IMFTransform, METransformHaveOutput, METransformNeedInput, MFCreateDXGIDeviceManager,
            MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFMediaType_Video, MFShutdown,
            MFStartup, MFTEnumEx, MFVideoFormat_AV1, MFVideoFormat_H264, MFVideoFormat_HEVC,
            MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFSTARTUP_LITE,
            MFT_CATEGORY_VIDEO_DECODER, MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER,
            MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_END_STREAMING,
            MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER,
            MFT_OUTPUT_DATA_BUFFER, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO,
            MF_EVENT_FLAG_NO_WAIT, MF_E_NO_EVENTS_AVAILABLE, MF_E_TRANSFORM_NEED_MORE_INPUT,
            MF_E_TRANSFORM_STREAM_CHANGE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
            MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK,
            MF_VERSION,
        },
        System::Com::CoTaskMemFree,
    },
};

struct MediaFoundation;
impl MediaFoundation {
    fn start() -> Result<Self, String> {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) }
            .map_err(|e| format!("Media Foundation decoder: {e}"))?;
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

pub struct HardwareVideoDecoder {
    transform: IMFTransform,
    _manager: IMFDXGIDeviceManager,
    activation: IMFActivate,
    events: Option<IMFMediaEventGenerator>,
    _runtime: MediaFoundation,
}

/// Superficie produzida pelo decoder. Decoders D3D11 normalmente usam uma
/// textura-array como pool; o frame valido nem sempre ocupa o slice zero.
pub struct DecodedSurface {
    pub texture: ID3D11Texture2D,
    pub subresource_index: u32,
}

impl HardwareVideoDecoder {
    pub fn open(
        device: &ID3D11Device,
        codec: VideoCodec,
        width: u32,
        height: u32,
        fps: u32,
    ) -> Result<Self, String> {
        let runtime = MediaFoundation::start()?;
        let activation = enumerate(codec)?
            .into_iter()
            .next()
            .ok_or_else(|| format!("Nenhum decoder {} por hardware disponível", codec.name()))?;
        unsafe {
            let transform: IMFTransform = activation
                .ActivateObject()
                .map_err(|e| format!("Ativação do decoder: {e}"))?;
            let attributes = transform.GetAttributes().map_err(|e| e.to_string())?;
            let asynchronous = attributes
                .GetUINT32(&MF_TRANSFORM_ASYNC)
                .unwrap_or_default()
                != 0;
            if asynchronous {
                attributes
                    .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                    .map_err(|e| format!("Desbloqueio do decoder assíncrono: {e}"))?;
            }
            let mut reset_token = 0;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut reset_token, &mut manager)
                .map_err(|e| format!("DXGI Device Manager do decoder: {e}"))?;
            let manager = manager.ok_or("Decoder não retornou gerenciador DXGI")?;
            manager
                .ResetDevice(device, reset_token)
                .map_err(|e| format!("Registro da GPU no decoder: {e}"))?;
            transform
                .ProcessMessage(
                    MFT_MESSAGE_SET_D3D_MANAGER,
                    Interface::as_raw(&manager) as usize,
                )
                .map_err(|e| format!("Decoder recusou o gerenciador D3D11: {e}"))?;
            let input = media_type(subtype(codec), width, height, fps)?;
            let output = media_type(MFVideoFormat_NV12, width, height, fps)?;
            transform
                .SetInputType(0, &input, 0)
                .and_then(|_| transform.SetOutputType(0, &output, 0))
                .map_err(|e| format!("Formato do decoder {}/NV12: {e}", codec.name()))?;
            let stream = transform
                .GetOutputStreamInfo(0)
                .map_err(|e| e.to_string())?;
            if stream.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
                return Err("Decoder de hardware não fornece superfícies DXGI".into());
            }
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .and_then(|_| transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0))
                .map_err(|e| format!("Inicialização do decoder: {e}"))?;
            let events = if asynchronous {
                Some(transform.cast().map_err(|e| e.to_string())?)
            } else {
                None
            };
            Ok(Self {
                transform,
                _manager: manager,
                activation,
                events,
                _runtime: runtime,
            })
        }
    }

    pub fn decode(
        &self,
        bytes: &[u8],
        timestamp_100ns: i64,
        duration_100ns: i64,
    ) -> Result<Option<DecodedSurface>, String> {
        if bytes.is_empty() {
            return Ok(None);
        }
        let length = u32::try_from(bytes.len()).map_err(|_| "Frame H.264 grande demais")?;
        unsafe {
            if let Some(events) = &self.events {
                wait_for(events, METransformNeedInput.0 as u32)?;
            }
            let buffer = MFCreateMemoryBuffer(length).map_err(|e| e.to_string())?;
            let mut destination = ptr::null_mut();
            buffer
                .Lock(&mut destination, None, None)
                .map_err(|e| e.to_string())?;
            ptr::copy_nonoverlapping(bytes.as_ptr(), destination, bytes.len());
            buffer.Unlock().map_err(|e| e.to_string())?;
            buffer.SetCurrentLength(length).map_err(|e| e.to_string())?;
            let sample = MFCreateSample().map_err(|e| e.to_string())?;
            sample.AddBuffer(&buffer).map_err(|e| e.to_string())?;
            sample
                .SetSampleTime(timestamp_100ns)
                .and_then(|_| sample.SetSampleDuration(duration_100ns))
                .map_err(|e| e.to_string())?;
            self.transform
                .ProcessInput(0, &sample, 0)
                .map_err(|e| format!("Entrada H.264 do decoder: {e}"))?;
            if let Some(events) = &self.events {
                wait_for(events, METransformHaveOutput.0 as u32)?;
            }
            for attempt in 0..2 {
                let mut output = MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    pSample: ManuallyDrop::new(None),
                    dwStatus: 0,
                    pEvents: ManuallyDrop::new(None),
                };
                let mut status = 0;
                let result =
                    self.transform
                        .ProcessOutput(0, slice::from_mut(&mut output), &mut status);
                let sample = ManuallyDrop::take(&mut output.pSample);
                drop(ManuallyDrop::take(&mut output.pEvents));
                if let Err(error) = result {
                    if error.code() == MF_E_TRANSFORM_STREAM_CHANGE && attempt == 0 {
                        self.renegotiate_output()?;
                        continue;
                    }
                    if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                        return Ok(None);
                    }
                    return Err(format!("Saída NV12 do decoder: {error}"));
                }
                let sample = sample.ok_or("Decoder não retornou amostra NV12")?;
                let buffer: IMFDXGIBuffer = sample
                    .GetBufferByIndex(0)
                    .and_then(|buffer| buffer.cast())
                    .map_err(|e| format!("Buffer DXGI decodificado: {e}"))?;
                let mut resource = ptr::null_mut();
                buffer
                    .GetResource(&ID3D11Texture2D::IID, &mut resource)
                    .map_err(|e| format!("Textura NV12 decodificada: {e}"))?;
                let texture = ID3D11Texture2D::from_raw(resource);
                let subresource_index = buffer
                    .GetSubresourceIndex()
                    .map_err(|e| format!("Slice NV12 decodificado: {e}"))?;
                return Ok(Some(DecodedSurface {
                    texture,
                    subresource_index,
                }));
            }
            Err("Decoder mudou de formato repetidamente".into())
        }
    }

    fn renegotiate_output(&self) -> Result<(), String> {
        unsafe {
            for index in 0..32 {
                let Ok(candidate) = self.transform.GetOutputAvailableType(0, index) else {
                    break;
                };
                if candidate.GetGUID(&MF_MT_SUBTYPE).ok() != Some(MFVideoFormat_NV12) {
                    continue;
                }
                self.transform
                    .SetOutputType(0, &candidate, 0)
                    .map_err(|e| format!("Renegociação NV12 do decoder: {e}"))?;
                let stream = self
                    .transform
                    .GetOutputStreamInfo(0)
                    .map_err(|e| e.to_string())?;
                if stream.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
                    return Err("Decoder renegociado não fornece superfícies DXGI".into());
                }
                return Ok(());
            }
        }
        Err("Decoder não ofereceu NV12 após mudar o formato".into())
    }
}

impl Drop for HardwareVideoDecoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = self.activation.ShutdownObject();
        }
    }
}

pub fn hardware_decoder_codecs() -> Result<Vec<VideoCodec>, String> {
    let _runtime = MediaFoundation::start()?;
    Ok(VideoCodec::ALL
        .into_iter()
        .filter(|codec| enumerate(*codec).is_ok_and(|items| !items.is_empty()))
        .collect())
}

fn subtype(codec: VideoCodec) -> GUID {
    match codec {
        VideoCodec::H264 => MFVideoFormat_H264,
        VideoCodec::H265 => MFVideoFormat_HEVC,
        VideoCodec::Av1 => MFVideoFormat_AV1,
    }
}

fn enumerate(codec: VideoCodec) -> Result<Vec<IMFActivate>, String> {
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: subtype(codec),
    };
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let mut activates: *mut Option<IMFActivate> = ptr::null_mut();
    let mut count = 0;
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_DECODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            Some(&output),
            &mut activates,
            &mut count,
        )
        .map_err(|e| format!("Enumeração de decoder {}: {e}", codec.name()))?;
        let mut decoders = Vec::with_capacity(count as usize);
        if !activates.is_null() {
            for activation in slice::from_raw_parts_mut(activates, count as usize) {
                if let Some(activation) = activation.take() {
                    decoders.push(activation);
                }
            }
            CoTaskMemFree(Some(activates.cast()));
        }
        Ok(decoders)
    }
}

unsafe fn media_type(
    subtype: GUID,
    width: u32,
    height: u32,
    fps: u32,
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
            .map_err(|e| format!("Tipo de mídia do decoder: {e}"))?;
    }
    Ok(media)
}

unsafe fn wait_for(events: &IMFMediaEventGenerator, expected: u32) -> Result<(), String> {
    let started = std::time::Instant::now();
    loop {
        let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => event,
            Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => {
                if started.elapsed() >= Duration::from_millis(500) {
                    return Err("Decoder de hardware não respondeu em 500 ms".into());
                }
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }
            Err(error) => return Err(format!("Evento do decoder: {error}")),
        };
        let status = unsafe { event.GetStatus() }.map_err(|e| e.to_string())?;
        status
            .ok()
            .map_err(|e| format!("Falha assíncrona do decoder: {e}"))?;
        if unsafe { event.GetType() }.map_err(|e| e.to_string())? == expected {
            return Ok(());
        }
    }
}
