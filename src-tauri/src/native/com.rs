use windows::{
    core::HRESULT,
    Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    },
};

/// Keeps COM balanced when Voxa initializes the current thread. Tauri command
/// threads may already be STA; RPC_E_CHANGED_MODE means COM is usable in that
/// existing apartment and must not be uninitialized by this guard.
pub(super) struct ComApartment {
    initialized_here: bool,
}

impl ComApartment {
    pub(super) fn multithreaded() -> Result<Self, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let initialized_here = classify_initialization(result)
            .map_err(|result| windows::core::Error::from_hresult(result).to_string())?;
        Ok(Self { initialized_here })
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialized_here {
            unsafe { CoUninitialize() }
        }
    }
}

fn classify_initialization(result: HRESULT) -> Result<bool, HRESULT> {
    if result.is_ok() {
        Ok(true)
    } else if result == RPC_E_CHANGED_MODE {
        Ok(false)
    } else {
        Err(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::{E_FAIL, S_FALSE, S_OK};

    #[test]
    fn preserves_an_existing_sta_apartment() {
        assert_eq!(classify_initialization(RPC_E_CHANGED_MODE), Ok(false));
    }

    #[test]
    fn balances_successful_com_initialization() {
        assert_eq!(classify_initialization(S_OK), Ok(true));
        assert_eq!(classify_initialization(S_FALSE), Ok(true));
        assert_eq!(classify_initialization(E_FAIL), Err(E_FAIL));
    }
}
