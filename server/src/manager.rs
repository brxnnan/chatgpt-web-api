use actix::{Actor, Addr, Context, Message, Handler};
use tokio::sync::oneshot;
use actix_web::web::Json;

use crate::{
    session::{self, CheckAvailable},
    ChatRequest,
    SocketCompletionResponse
};

#[derive(Debug)]
pub struct ServerState {
    // addr: Addr<ChatHandler>
    sockets: Vec<Addr<session::WsSession>>
}

impl ServerState {
    pub fn new() -> Self {
        Self { sockets: Vec::new() }
    }
}

impl Actor for ServerState {
    /// We are going to use simple Context, we just need ability to communicate
    /// with other actors.
    type Context = Context<Self>;
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct RegisterSocket {
    pub addr: Addr<session::WsSession>
}

/// register new socket
impl Handler<RegisterSocket> for ServerState {
    type Result = ();

    fn handle(&mut self, msg: RegisterSocket, _: &mut Context<Self>) -> Self::Result {
        log::debug!("New socket connection");

        self.sockets.push(msg.addr);
    }
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct UnregisterSocket {
    pub addr: Addr<session::WsSession>
}

/// unregister a socket
impl Handler<UnregisterSocket> for ServerState {
    type Result = ();

    fn handle(&mut self, msg: UnregisterSocket, _: &mut Context<Self>) -> Self::Result {
        log::debug!("Removing socket");

        self.sockets.remove(self.sockets.iter().position(|x| *x == msg.addr).expect("unable to find socket to remove"));
    }
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct SendToSocket {
    pub sender: oneshot::Sender<SocketCompletionResponse>,
    pub prompt: Json<ChatRequest>,
}

impl Handler<SendToSocket> for ServerState {
    type Result = ();

    fn handle(&mut self, msg: SendToSocket, _ctx: &mut Context<Self>) -> Self::Result {
        // disgusting
        let sockets = self.sockets.clone();
        tokio::task::spawn(async move {
            for socket in sockets.iter() {
                if socket.send(CheckAvailable).await.unwrap_or(false) {
                    socket.do_send(session::SendPrompt { sender: msg.sender, prompt: msg.prompt });
                    // the socket's actor will handle actually returning to sender
                    return;
                }
            }
            msg.sender
                .send(SocketCompletionResponse {
                    succeeded: false,
                    message: "no available clients to handle prompt".to_string()
                })
                .unwrap();
        });
    }
}
