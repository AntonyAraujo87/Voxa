//! Janela flutuante que mostra quem esta falando por cima do jogo.
//!
//! Sem hook de DirectX/D3D de proposito: injetar no processo do jogo pra
//! desenhar por cima dele e exatamente o padrao que anticheat (Vanguard,
//! EAC, BattlEye) trata como ameaca — derrubaria o Voxa numa lista negra ou,
//! pior, o proprio jogo do usuario. Uma janela normal, transparente e
//! always-on-top e o que Discord e Parsec tambem fazem por padrao: funciona
//! em janela/borderless, nao em fullscreen exclusivo — troca deliberada.
//!
//! O estado (quem fala) mora na janela principal, que ja tem toda a logica
//! de voz; aqui so existe a JANELA. A ponte e um evento Tauri comum
//! (`overlay:roster`), emitido pelo frontend da janela principal e ouvido
//! pelo frontend da janela overlay — as duas rodam processos de WebView
//! separados, sem memoria compartilhada.

use tauri::{
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const LABEL: &str = "overlay";

/// Canto superior esquerdo, com uma folga pra nao encostar na borda.
const PADRAO: (f64, f64) = (40.0, 40.0);

#[tauri::command]
pub fn set_overlay_enabled(
    app: AppHandle,
    on: bool,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if !on {
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.close();
        }
        return Ok(());
    }

    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }

    // Nasce invisivel: a posicao salva so pode ser aplicada DEPOIS da janela
    // existir (ver `mover_para`), e criar visivel no lugar padrao faria o
    // overlay piscar num canto antes de pular pro lugar certo.
    let win = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#overlay".into()))
        .title("Voxa")
        .inner_size(220.0, 360.0)
        .position(PADRAO.0, PADRAO.1)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    if let (Some(x), Some(y)) = (x, y) {
        mover_para(&win, x, y);
    }

    // So um indicador visual — clique atravessa pra janela (ou jogo) por
    // baixo. Sem isso a pessoa clicaria sem querer numa janela invisivel
    // por cima do jogo e perderia o foco dele.
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.show();

    Ok(())
}

/// Liga/desliga o modo posicionar: com `on = true` a janela volta a receber
/// clique, pra poder ser arrastada.
///
/// Enquanto isso vale, o overlay ESTA no caminho do mouse — e por isso que
/// o frontend cobre a tela inteira de saidas (botao, Esc, desligar o
/// overlay) e que fechar a janela sempre volta pro estado travado.
#[tauri::command]
pub fn overlay_set_movable(app: AppHandle, on: bool) -> Result<(), String> {
    let win = app
        .get_webview_window(LABEL)
        .ok_or("overlay nao esta aberto")?;
    win.set_ignore_cursor_events(!on)
        .map_err(|e| e.to_string())?;
    if on {
        // Sem foco o WebView nao entrega `keydown`, e o Esc — a saida de
        // emergencia se o botao ficar fora da tela — nao funcionaria.
        let _ = win.set_focus();
    }
    Ok(())
}

/// Arrasta a janela junto com o mouse.
///
/// Fica no Rust em vez de `getCurrentWindow().startDragging()` para o
/// overlay nao precisar da permissao `core:window` — ele segue com o
/// minimo, so eventos.
#[tauri::command]
pub fn overlay_drag(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window(LABEL)
        .ok_or("overlay nao esta aberto")?;
    win.start_dragging().map_err(|e| e.to_string())
}

/// Posicao atual em coordenadas LOGICAS, ja resgatada se estiver fora da tela.
///
/// A conversao importa: `outer_position` devolve pixel fisico, e no Windows
/// a 125% ou 150% (o padrao em notebook) isso e diferente do valor que o
/// builder espera. Salvar fisico e reaplicar como logico faria o overlay
/// andar sozinho pra longe a cada vez que o app abrisse.
///
/// O resgate existe porque uma janela sem decoracao pode ser arrastada pra
/// fora de qualquer monitor. Se isso acontecesse, o overlay sumiria da vista
/// AINDA no modo posicionar — ou seja, invisivel e comendo os cliques do
/// jogo, com o botao "Fixar" e o Esc fora de alcance. Volta pro canto.
#[tauri::command]
pub fn overlay_position(app: AppHandle) -> Result<(f64, f64), String> {
    let win = app
        .get_webview_window(LABEL)
        .ok_or("overlay nao esta aberto")?;
    let escala = win.scale_factor().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;

    if !na_tela(&win, pos) {
        mover_para(&win, PADRAO.0, PADRAO.1);
        return Ok(PADRAO);
    }

    let logica = pos.to_logical::<f64>(escala);
    Ok((logica.x, logica.y))
}

/// O canto superior esquerdo cai dentro de algum monitor ligado agora?
fn na_tela(win: &WebviewWindow, p: PhysicalPosition<i32>) -> bool {
    let Ok(monitores) = win.available_monitors() else {
        // Sem conseguir enumerar monitor, o palpite seguro e "esta ok": mexer
        // na posicao as cegas seria pior que deixar onde o usuario soltou.
        return true;
    };
    monitores.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        p.x >= mp.x && p.y >= mp.y && p.x < mp.x + ms.width as i32 && p.y < mp.y + ms.height as i32
    })
}

/// Aplica uma posicao logica salva, ignorando-a se cair fora de todo
/// monitor ligado agora.
///
/// Sem essa checagem, quem posiciona o overlay num segundo monitor e depois
/// desconecta ele abre o app com o overlay invisivel — e sem nada na tela
/// dizendo que ele esta ligado, o sintoma vira "o overlay parou de
/// funcionar", que e o tipo de bug que ninguem consegue relatar direito.
fn mover_para(win: &WebviewWindow, x: f64, y: f64) {
    let Ok(escala) = win.scale_factor() else {
        return;
    };
    let fisico = PhysicalPosition::new((x * escala) as i32, (y * escala) as i32);

    if na_tela(win, fisico) {
        let _ = win.set_position(fisico);
    }
}
