use std::time::Duration;

use actix_web::{
    post,
    get,
    web::{self},
    App,
    HttpServer,
    HttpResponse,
    Responder,
    HttpRequest
};
use actix::{Addr, Actor};
use actix_web_actors::ws;
use serde::{Deserialize, Serialize};
use tokio::{sync::oneshot, time::timeout};
use env_logger;

mod manager;
mod session;

#[derive(Debug)]
pub struct SocketCompletionResponse {
    succeeded: bool,
    message: String,
}

#[derive(Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
    name: Option<String>,
}

/// https://platform.openai.com/docs/api-reference/chat/create
#[derive(Serialize, Deserialize)]
pub struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
}

///////////////////

#[derive(Serialize)]
struct ChatCompletionMessage {
    content: String,
    role: String,
}
#[derive(Serialize)]
struct ChatCompletionChoice {
    finish_reason: String,
    index: i32,
    message: ChatCompletionMessage,
}
// subset of the error structure returned by openai
// visit https://api.openai.com/v1/chat/completions for a basic error
#[derive(Serialize)]
struct ChatResponseError {
    message: String,
}
// json structure which form the response from the /chat/completions api
#[derive(Serialize)]
struct ChatCompletion {
    choices: Option<Vec<ChatCompletionChoice>>,
    error: Option<ChatResponseError>,
}

// helper function to simplify returning errors
fn response_error(err_msg: String) -> ChatCompletion {
    ChatCompletion {
        choices: None,
        error: Some(ChatResponseError {
            message: err_msg
        })
    }
}

#[post("/v1/chat/completions")]
async fn chat_completion_endpoint(
    request: web::Json<ChatRequest>,
    data: web::Data<Addr<manager::ServerState>>
) -> impl Responder {
    if request.messages.len() == 0 {
        return HttpResponse::BadRequest()
            .json(response_error("need at least one message".to_string()));
    }

    // create the oneshot channel
    let (tx, rx) = oneshot::channel::<SocketCompletionResponse>();

    data.do_send(manager::SendToSocket { sender: tx, prompt: request });

    // await its response (2 min timeout)
    match timeout(Duration::from_secs(60 * 2), rx).await {
        // socket successfully completed
        Ok(Ok(completion)) if completion.succeeded => HttpResponse::Ok()
            .json(ChatCompletion {
                choices: Some(vec![
                    ChatCompletionChoice {
                        finish_reason: "stop".to_string(),
                        index: 0,
                        message: ChatCompletionMessage {
                            content: completion.message,
                            role: "assistant".to_string(),
                        }
                    }
                ]),
                error: None,
            }),
        // socket had to disconnect the completion
        Ok(Ok(completion)) => HttpResponse::InternalServerError()
            .json(response_error(format!("socket disconnected: {}", completion.message))),
        Ok(Err(err)) => HttpResponse::InternalServerError()
            .json(response_error(format!("internal failure: {}", err))),
        Err(_) => HttpResponse::RequestTimeout()
            .json(response_error("chat completion took too long".to_string())),
    }
}

#[get("/ws")]
async fn ws_index(
    req: HttpRequest,
    stream: web::Payload,
    data: web::Data<Addr<manager::ServerState>>
) -> impl Responder {
    let (addr, resp) = ws::WsResponseBuilder::new(
        session::WsSession::new(data.get_ref().clone()),
        &req,
        stream
    ).start_with_addr().unwrap();

    data.do_send(manager::RegisterSocket { addr });

    resp
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    std::env::set_var("RUST_LOG", "debug");
    env_logger::init();

    let state = manager::ServerState::new().start();

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(state.clone()))
            .service(ws_index)
            .service(chat_completion_endpoint)
    })
    .bind(("127.0.0.1", 4000))?
    .run()
    .await
}
