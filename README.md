# ChatGPT Web API
Mimics OpenAI's chat completion API via a combination of a browser extension and a locally hosted webserver. Useful for automation and external applications that support OpenAI's API. This is a toy hobbyist project and won't necessarily receive updates.

## Installation
For the extension:

1. In the `extension` directory, run `npm run build`
2. Install the extension manually using either Firefox or Chrome by selecting its manifest in its respective directory, generated under `dist`
   + For Firefox specifically, make sure it has the necessary permissions (i.e. under the extension, enable Permissions -> Optional permissions; this is because it's using MV3)

## Usage
Run `cargo run` under the `server` directory. The server should start and will create an endpoint which'll accept new WebSocket connections for the extension. It'll also host the completion endpoint at `http://localhost:4000/v1/chat/completions`

The extension's icon will light up green when the socket is connected to the local web server and the current tab in the browser window is the one which'll be used for automating responses. Multiple tabs open at address `chat.openai.com` will cause the extension to choose one at random (you can click through each, watching the icon to see when it turns green to determine which is the selected one).

## Design Decisions
The project was designed using an extension instead of reverse engineering OpenAI's backend protocol for the sake of time; since they've transitioned to using WebSockets for streaming the web chat, it'd be more work to do and more maintenance to upkeep. With the extension, all that has to be done is manually interact with nodes in the webpage via JS. It was also used as an intro to Rust, which is why the backend is written in it. Note that the extension isn't published to any of the browser stores to avoid the possibility of them being taken down.

## Drawbacks
+ Requires an open tab to work
+ No streaming support
+ Model switching in the API request doesn't work (currently has to be done manually via clicking in the tab open in the browser)
+ Correct timeouts: currently the web server will timeout after 2 minutes. It should timeout instead when the connected socket stops receiving messages (because in its current state it will continue clicking the "Continue generating" button infinitely that will show up after a while, and that can go on for multiple minutes).
