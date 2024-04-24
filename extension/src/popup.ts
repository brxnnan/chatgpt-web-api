import * as browser from "webextension-polyfill"

// grab the original tab id if we're in a pop out window
// otherwise, it is populated before start
let tabId: string | number | null = (new URLSearchParams(window.location.search)).get("tabId")
const isPopout: boolean = tabId !== null

// if we grab it from the URL, it's a string
if (tabId) tabId = parseInt(tabId)

function init() {
    // connect to the service worker
    const port = browser.runtime.connect({ name: "popup" })

    const popOutButton: HTMLButtonElement = document.getElementById("popOutBtn") as HTMLButtonElement
    const sendPromptButton: HTMLButtonElement = document.getElementById("sendPrompt") as HTMLButtonElement
    const setPrimaryButton: HTMLButtonElement = document.getElementById("setPrimary") as HTMLButtonElement

    const isGeneratingDiv: HTMLDivElement = document.getElementById("isGenerating") as HTMLDivElement
    const socketStatusDiv: HTMLDivElement = document.getElementById("socketStatus") as HTMLDivElement

    if (isPopout) {
        popOutButton.style.display = "none"
    } else {
        popOutButton.addEventListener("click", () => {
            // use the browser.windows.create API to open a new window with popup.html
            browser.windows.create({
                url: `${browser.runtime.getURL("popup.html")}?tabId=${tabId}`,
                type: "popup",
                width: 350,
                height: 150
            }).then(() => window.close()) // close the current popup since its contents have been moved to a new window
        })
    }

    sendPromptButton.addEventListener("click", () => {
        const prompt = (document.getElementById("promptInput") as HTMLTextAreaElement).value
        if (!prompt) return

        port.postMessage({
            action: "runPrompt",
            data: {
                model: null,
                messages: {
                    role: "User",
                    content: prompt
                }
            }
        })
    })

    setPrimaryButton.addEventListener(
        "click",
        () => port.postMessage({ action: "setPrimaryTab", data: tabId })
    )

    port.onMessage.addListener((message: { action: string; data: any }) => {
        switch (message.action) {
        case "isGenerating": {
            isGeneratingDiv.textContent = `ChatGPT: ${message.data ? "Responding" : "Idle"}`
            break
        }
        case "socketStatus": {
            socketStatusDiv.textContent = `Socket: ${message.data ? "Connected" : "Disconnected"}`
            break
        }
        default: {
            console.error(`Invalid popup message action: ${message.action}`)
            break
        }
        }
    })
}

document.addEventListener("DOMContentLoaded", () => {
    if (isPopout) {
        init()
    } else {
        // get tab id first, then init
        browser.tabs
               .query({ active: true, currentWindow: true })
               .then((tabs: browser.Tabs.Tab[]) => {
                   if (tabs[0] && tabs[0].id) {
                       tabId = tabs[0].id
                       console.log("Got tab id!")
                       init()
                   } else {
                       console.error("Unable to find tab id!")
                   }
               })
    }
})
