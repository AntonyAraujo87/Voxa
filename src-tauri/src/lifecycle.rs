//! Ciclo de vida da janela: bandeja do sistema e consumo de memoria.
//!
//! O Voxa fica horas aberto em segundo plano enquanto o usuario joga. Nesse
//! estado ele nao precisa de nada alem do motor de rede — a janela nem
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
///
/// Tambem em outra thread: o comando volta na hora e a varredura acontece por
/// fora, sem segurar quem chamou.
#[tauri::command]
pub fn release_memory() {
    std::thread::spawn(trim_memory);
}

/// Icone na bandeja com menu de Abrir e Sair.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    // Sem icone nao ha bandeja — mas isso nao pode derrubar o app inteiro.
    // Um `expect` aqui transformaria um detalhe cosmetico num crash no boot.
    let Some(icone) = app.default_window_icon().cloned() else {
        eprintln!("[voxa] sem icone padrao: bandeja desativada");
        return Ok(());
    };

    let abrir = MenuItem::with_id(app, "abrir", "Abrir Voxa", true, None::<&str>)?;
    let sair = MenuItem::with_id(app, "sair", "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&abrir, &sair])?;

    TrayIconBuilder::with_id("voxa-tray")
        .icon(icone)
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

/// Fechar esconde na bandeja em vez de encerrar; o transporte pode continuar.
pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    // Somente a janela principal vira bandeja. A janela nativa do stream fecha
    // normalmente e pode ser criada novamente pelo motor.
    if window.label() != "main" {
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.app_handle().tray_by_id("voxa-tray").is_none() {
            return;
        }
        api.prevent_close();
        let _ = window.hide();
        // O stream pode continuar ativo; o motor nativo controla sua memoria.
    }
}
