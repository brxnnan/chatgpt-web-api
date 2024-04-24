import * as browser from "webextension-polyfill"

const socketURL: string = "ws://localhost:4000/ws"
const reconnectionDelay: number = 3

let socket: WebSocket | null = null
let popupPort: browser.Runtime.Port | null = null
let contentPort: browser.Runtime.Port | null = null

function runPrompt(prompt: string) {
    if (contentPort) {
        contentPort.postMessage({ action: "runPrompt", data: prompt })
    } else {
        console.error("[background] Attempt to run prompt when content port is not set")
    }
}

function isConnected(): boolean {
    return socket?.readyState === WebSocket.OPEN
}

function updateIcon() {
    if (isConnected() && contentPort) {
        // set color version if the current tab is the one the content script is running on
        browser.tabs.query({ active: true, currentWindow: true }).then((tabs: browser.Tabs.Tab[]) => {
            // note: contentPort can be changed between the outer if check and this code, since `query` is async
            const icon: string =
                tabs.length > 0 && contentPort && tabs[0]!.id === contentPort.sender?.tab?.id
                    ? "icon"
                    : "grayscale_icon"
            browser.action.setIcon({ path: `icons/${icon}.webp` })
        })
    } else {
        // we aren't connected
        browser.action.setIcon({ path: "icons/grayscale_icon.webp" })
    }
}

// array which contains the open ChatGPT windows which have content scripts running on them
// we keep track of these in case we need to switch `contentPort` to another (its tab is closed)
const contentPortsPool: browser.Runtime.Port[] = []

function contentPortOnMessage(message: { action: string; data: any }) {
    console.log("[background] Received content port message:", message)
    switch (message.action) {
    case "isGenerating": {
        // we proxy through the background script to avoid having to communicate between
        // the content script and the popup script
        popupPort?.postMessage({ action: "isGenerating", data: message.data })
        break
    }
    case "sendToSocket": {
        if (!isConnected()) {
            console.error("[background] Attempt to stream response back to socket but it's not ready")
            break
        }

        socket!.send(JSON.stringify({
            action: message.data.action,
            data: message.data.data
        }))

        break
    }
    default: {
        console.error("[background] Invalid message action sent from content script:", message.action)
        break
    }
    }
}

function connectContentPort(port: browser.Runtime.Port) {
    contentPort = port

    updateIcon()

    port.onMessage.addListener(contentPortOnMessage)
}

browser.runtime.onConnect.addListener(port => {
    if (port.name === "popup") {
        // console.log("New popup port:", port)
        // console.log("Previous popup port:", popupPort)

        popupPort = port

        port.onMessage.addListener(message => {
            console.log("[background] Received popup message:", message)
            switch (message.action) {
            case "runPrompt": {
                runPrompt(message.data)
                break
            }
            case "setPrimaryTab": {
                // override the default primary tab that we selected with the user's preference
                let found: browser.Runtime.Port | undefined
                for (const port of contentPortsPool) {
                    if (port.sender?.tab?.id === message.data) {
                        found = port
                        break
                    }
                }
                if (!found) {
                    console.log("[background] setPrimaryTab: unable to set tab (can't find)")
                    break
                } else if (found === contentPort) {
                    // TODO: doesn't work fully on extension reload?
                    // if it's set to itself ignore
                    break
                }

                if (!contentPort) break

                // remove the listener for the previous contentPort
                contentPort.onMessage.removeListener(contentPortOnMessage)

                connectContentPort(found)

                break
            }
            default: {
                console.error("[background] Invalid message action sent from popup:", message.action)
                break
            }
            }
        })

        port.onDisconnect.addListener(() => {
            console.log("Popup port disconnected")
            popupPort = null
        })

        // send initial state
        port.postMessage({ action: "socketStatus", data: isConnected() })
    } else if (port.name === "content") {
        contentPortsPool.push(port)

        port.onDisconnect.addListener(() => {
            console.log("Content port disconnected")

            if (port === contentPort) contentPort = null

            // remove from pool
            const index = contentPortsPool.indexOf(port)
            if (index > -1) contentPortsPool.splice(index, 1)

            // connect the next available tab
            if (contentPortsPool.length > 0)
                connectContentPort(contentPortsPool[0]!)
            else
                updateIcon()

            console.log(`new contentPortsPool size: ${contentPortsPool.length}`)
        })

        if (!contentPort) {
            console.log("[background] Set content port")

            connectContentPort(port)
        } else {
            console.log("A new tab has opened, but the old is still open as well; using the old tab")
        }
    }
})

function socketConnect() {
    socket = new WebSocket(socketURL)

    socket.onopen = () => {
        console.log("Socket connected")

        popupPort?.postMessage({ action: "socketStatus", data: true })

        updateIcon()
    }
    socket.onclose = () => {
        console.log(`Socket closed, attempting to reconnect in ${reconnectionDelay} seconds`)
        setTimeout(socketConnect, reconnectionDelay * 1000)

        popupPort?.postMessage({ action: "socketStatus", data: false })

        updateIcon()

        socket = null
    }
    socket.onerror = (error) => console.error("Socket error:", error)
    socket.onmessage = (event) => {
        console.log(`Received message from server: ${event.data}`)

        const message = JSON.parse(event.data)

        switch (message.action) {
        case "sendPrompt": {
            console.log("[background] Received prompt request from socket:", message.data)

            runPrompt(message.data)

            break
        }
        default: {
            console.log("[background]: Received invalid socket action:", message.action)
            break
        }
        }
    }
}

// init

// make the extension's icon update be triggered by switching tabs
browser.tabs.onActivated.addListener(updateIcon)
browser.tabs.onUpdated.addListener(updateIcon)

updateIcon()

// repeatedly send data (ping) to the socket to keep it alive
// https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets
// https://stackoverflow.com/a/66618269
// https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/functional-samples/tutorial.websockets/service-worker.js
setInterval(() => {
    if (isConnected()) socket!.send(JSON.stringify({ action: "ping" }))
}, 10 * 1000)

console.log("Attempting initial socket connection...")
socketConnect()
