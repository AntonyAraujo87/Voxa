//! Registro de falhas do processo nativo.
//!
//! Um panic no Rust derruba o app inteiro e leva a mensagem junto: o console
//! do WebView2 nem chega a ver, e a janela some antes de qualquer coisa
//! aparecer. Gravar em arquivo e o unico jeito de a informacao sobreviver ao
//! proprio crash e estar la quando o usuario reabrir.
//!
//! Nada e enviado para lugar nenhum. O arquivo fica na pasta de dados do app
//! e so sai dali se a pessoa clicar em "copiar diagnostico".

use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Teto do arquivo. Um panic em laco poderia encher o disco; alem disso, o que
/// interessa e sempre a falha mais recente.
const MAX_BYTES: u64 = 64 * 1024;

fn caminho(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    create_dir_all(&dir).ok()?;
    Some(dir.join("panics.log"))
}

/// Liga o gancho de panic. Chamado uma vez, no setup.
pub fn setup(app: &AppHandle) {
    let Some(arquivo) = caminho(app) else { return };

    // O hook anterior imprime no stderr; manter os dois preserva o
    // comportamento em `tauri dev`, onde o terminal esta a vista.
    let anterior = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info| {
        // Se o arquivo passou do teto, recomeca: interessa a falha recente.
        if arquivo.metadata().map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
            let _ = std::fs::remove_file(&arquivo);
        }

        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&arquivo) {
            let local = info.location();
            let _ = writeln!(
                f,
                "[{}] {} em {}:{}",
                agora(),
                info.payload().downcast_ref::<&str>().copied().unwrap_or("panic"),
                local.map(|l| l.file()).unwrap_or("?"),
                local.map(|l| l.line()).unwrap_or(0),
            );
        }

        anterior(info);
    }));
}

fn agora() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "?".into())
}

/// Devolve o que foi registrado, para o botao de diagnostico da interface.
#[tauri::command]
pub fn read_panic_log(app: AppHandle) -> String {
    let Some(arquivo) = caminho(&app) else {
        return String::new();
    };
    let Ok(mut f) = std::fs::File::open(&arquivo) else {
        return String::new();
    };
    let mut buf = String::new();
    let _ = f.read_to_string(&mut buf);
    buf
}
