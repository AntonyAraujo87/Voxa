//! Ciclo de vida da janela: bandeja do sistema e consumo de memoria.
//!
//! O Voxa fica horas aberto em segundo plano enquanto o usuario joga. Nesse
//! estado ele nao precisa de nada alem do audio e da conexao — a janela nem
//! esta sendo desenhada. Aqui devolvemos ao sistema tudo o que da.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};

/// Devolve ao sistema as paginas de memoria que o processo nao esta usando.
///
/// `EmptyWorkingSet` nao "vaza" nem corrompe nada: as paginas continuam
/// validas no arquivo de paginacao e voltam sob demanda. O efeito pratico e
/// que o working set (o numero que aparece no Gerenciador de Tarefas) cai de
/// centenas de MB para dezenas enquanto o app esta minimizado.
///
/// Precisa ser aplicado tambem aos processos do WebView2: eles sao a maior
/// parte do consumo, e sao processos separados, filhos do nosso.
#[cfg(target_os = "windows")]
pub fn trim_memory() {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, PROCESS_QUERY_INFORMATION,
        PROCESS_SET_QUOTA,
    };

    unsafe {
        let _ = EmptyWorkingSet(GetCurrentProcess());

        let eu = GetCurrentProcessId();
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return;
        };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID == eu {
                    if let Ok(handle) = OpenProcess(
                        PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA,
                        false,
                        entry.th32ProcessID,
                    ) {
                        let _ = EmptyWorkingSet(handle);
                        let _ = CloseHandle(handle);
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn trim_memory() {}

/// Libera memoria sob demanda, chamado pelo frontend quando a janela some.
#[tauri::command]
pub fn release_memory() {
    trim_memory();
}

/// Icone na bandeja com menu de Abrir e Sair.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let abrir = MenuItem::with_id(app, "abrir", "Abrir Voxa", true, None::<&str>)?;
    let sair = MenuItem::with_id(app, "sair", "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&abrir, &sair])?;

    TrayIconBuilder::with_id("voxa-tray")
        .icon(app.default_window_icon().cloned().expect("icone do app"))
        .tooltip("Voxa")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "abrir" => restore(app),
            "sair" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Clique esquerdo simples traz a janela de volta.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn restore(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Ultima liberacao de memoria, em segundos desde a epoca.
static ULTIMO_TRIM: AtomicU64 = AtomicU64::new(0);
const INTERVALO_MINIMO_S: u64 = 20;

/// `Resized` dispara em rajada durante a animacao de minimizar. Sem esta
/// travar, EmptyWorkingSet rodaria dezenas de vezes seguidas, varrendo a lista
/// de processos filhos a cada uma — trabalho puro para nenhum ganho extra.
fn trim_memory_debounced() {
    let agora = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let anterior = ULTIMO_TRIM.load(Ordering::Relaxed);
    if agora.saturating_sub(anterior) < INTERVALO_MINIMO_S {
        return;
    }
    ULTIMO_TRIM.store(agora, Ordering::Relaxed);
    trim_memory();
}

/// Fechar esconde na bandeja em vez de encerrar; a chamada de voz continua.
pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
            trim_memory_debounced();
        }
        // Minimizar tambem e um bom momento: a janela para de ser desenhada.
        WindowEvent::Resized(_) if window.is_minimized().unwrap_or(false) => {
            trim_memory_debounced();
        }
        _ => {}
    }
}
