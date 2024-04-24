use actix::{
    Actor,
    StreamHandler,
    prelude::*
};
use actix_web::web::Json;
use actix_web_actors::ws;
use tokio::sync::oneshot;
use serde::Deserialize;
use serde_json::json;

use crate::{
    manager::{ServerState, UnregisterSocket},
    ChatRequest,
    SocketCompletionResponse
};

/// define HTTP actor
#[derive(Debug)]
pub struct WsSession {
    /// the chunks we've received from the extension
    chunks: Vec<String>,
    /// actix actor address of the corresponding `ServerState`
    manager_addr: Addr<ServerState>,
    /// the http api endpoint which is waiting for the response
    sender: Option<oneshot::Sender<SocketCompletionResponse>>,
}

#[derive(Deserialize)]
struct ExtensionResponse {
    action: String,
    data: Option<String>
}

impl WsSession {
    pub fn new(manager_addr: Addr<ServerState>) -> Self {
        Self {
            chunks: Vec::new(),
            sender: None,
            manager_addr,
        }
    }
    fn send_prompt(&self, ctx: &mut ws::WebsocketContext<Self>, msg: Json<ChatRequest>) {
        // run the prompt on the extension
        ctx.text(json!({
            "action": "sendPrompt",
            "data": msg
        }).to_string());
    }
    /// check to see if we're idle and able to accept specific messages
    /// currently idle if `self.sender` is None
    fn is_idle(&self) -> bool {
        self.sender.is_none()
    }
    fn handle_msg(&mut self, ctx: &mut ws::WebsocketContext<Self>, resp: ExtensionResponse) {
        match resp.action.as_str() {
            // the extension will send "ping" to keep the service worker alive
            "ping" => (),
            action @ ("chatStart" | "chatChunk" | "chatEnd") if !self.is_idle() => match action {
                "chatStart" => {
                    log::debug!("the client sent `chatStart`");
                    self.chunks.clear();
                },
                "chatChunk" => {
                    let chunk = resp.data.unwrap();
                    log::debug!("NEW CHAT CHUNK: {}", chunk);
                    self.chunks.push(chunk);
                },
                "chatEnd" => {
                    log::debug!("CHAT ENDED!");
                    if let Some(sender) = self.sender.take() {
                        if !sender.is_closed()
                            && sender.send(SocketCompletionResponse { succeeded: true, message: self.chunks.join("") }).is_ok() {
                                self.disconnect_chat(ctx, "transmission completed");
                            } else {
                                self.disconnect_chat(ctx, "failed to send completion (send failed)");
                            }
                    } else {
                        log::debug!("Attempt to send response back with invalid sender");
                        self.disconnect_chat(ctx, "failed to send completion (sender not open)");
                    }
                },
                _ => unreachable!(),
            },
            _ => self.disconnect_chat(ctx, "invalid message action"),
        }
    }
    fn disconnect_chat(&mut self, _ctx: &mut ws::WebsocketContext<Self>, msg: &str) {
        log::debug!("Chat disconnected because: {}", msg);

        if let Some(sender) = self.sender.take() {
            sender
                .send(SocketCompletionResponse {
                    succeeded: false,
                    message: msg.to_string()
                })
                .unwrap();
        }

        self.chunks.clear();
    }
}

impl Actor for WsSession {
    type Context = ws::WebsocketContext<Self>;
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for WsSession {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Text(text)) => self.handle_msg(
                ctx,
                serde_json::from_str::<ExtensionResponse>(&text.to_string()).unwrap()
            ),
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Pong(_)) | Ok(ws::Message::Nop) => (),
            _ => ctx.close(Some(ws::CloseReason {
                code: ws::CloseCode::Unsupported,
                description: Some("only text messages are supported".to_string()),
            })),
        }
    }
    fn finished(&mut self, ctx: &mut Self::Context) {
        log::debug!("Socket: finished streaming");

        self.manager_addr.do_send(UnregisterSocket { addr: ctx.address() });
    }
}

#[derive(Message)]
#[rtype(result = "bool")]
pub struct CheckAvailable;

impl Handler<CheckAvailable> for WsSession {
    type Result = bool;

    fn handle(&mut self, _msg: CheckAvailable, _ctx: &mut Self::Context) -> Self::Result {
        self.is_idle()
    }
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct SendPrompt {
    pub sender: oneshot::Sender<SocketCompletionResponse>,
    pub prompt: Json<ChatRequest>,
}

impl Handler<SendPrompt> for WsSession {
    type Result = ();

    fn handle(&mut self, msg: SendPrompt, ctx: &mut Self::Context) -> Self::Result {
        assert!(self.sender.is_none(), "attempt to connect to socket while busy");

        self.sender = Some(msg.sender);
        self.send_prompt(ctx, msg.prompt);
    }
}
