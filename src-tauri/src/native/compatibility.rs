use super::GraphicsAdapterInfo;
use serde::Serialize;
#[cfg(test)]
use voxa_native_core::protocol::VideoCodec;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GpuCompatibilityProfile {
    pub key: String,
    pub disabled_codecs: Vec<&'static str>,
    pub disabled_controls: Vec<&'static str>,
    pub reason: Option<&'static str>,
}

// Conservative rules only. Unknown hardware is runtime-probed by opening a
// real MFT on the selected D3D11 adapter; a failed probe never gets advertised.
const SOFTWARE_ADAPTER_VENDOR: u32 = 0x1414;

pub(super) fn profile(adapter: &GraphicsAdapterInfo) -> GpuCompatibilityProfile {
    let software = adapter.vendor_id == SOFTWARE_ADAPTER_VENDOR;
    GpuCompatibilityProfile {
        key: format!(
            "{:04x}:{:04x}:{}",
            adapter.vendor_id,
            adapter.device_id,
            adapter.driver_version.as_deref().unwrap_or("unknown")
        ),
        disabled_codecs: if software {
            vec!["av1", "h265", "h264"]
        } else {
            Vec::new()
        },
        disabled_controls: Vec::new(),
        reason: software
            .then_some("Adaptador de software da Microsoft não oferece pipeline de baixa latência"),
    }
}

#[cfg(test)]
fn allows(adapter: &GraphicsAdapterInfo, codec: VideoCodec) -> bool {
    !profile(adapter).disabled_codecs.contains(&codec.name())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn software_adapter_is_never_advertised_as_hardware() {
        let adapter = GraphicsAdapterInfo {
            adapter_index: 0,
            name: "Microsoft Basic Render Driver".into(),
            dedicated_memory_mb: 0,
            vendor_id: SOFTWARE_ADAPTER_VENDOR,
            device_id: 0x008c,
            revision: 0,
            driver_version: Some("10.0".into()),
        };
        assert!(!allows(&adapter, VideoCodec::H264));
        assert_eq!(profile(&adapter).disabled_codecs.len(), 3);
    }
}
