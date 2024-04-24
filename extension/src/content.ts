// manifest.json manifest v3 permissions issues: https://discourse.mozilla.org/t/blog-post-manifest-v3-in-firefox-recap-next-steps/97372/7
// firefox vs chrome issue: https://stackoverflow.com/a/78088358

import * as browser from "webextension-polyfill"

type ChatMessage = {
    role: string;
    content: string;
    name?: string | null;
}
type ChatRequest = {
    model: string;
    messages: ChatMessage[];
}

(function() {
    const DEBUG = false

    function debugLog(...messages: any[]) {
        if (!DEBUG) return

        console.log(...messages)
    }

    if (window.location.host !== "chat.openai.com") {
        debugLog("Invalid webpage, not running...")
        return
    }

    // connect to the service worker
    const port = browser.runtime.connect({ name: "content" })

    // how much time to wait after ChatGPT stops responding to end the chat
    const responseInactivityThreshold = 5

    function socketSend(action: string, data: any) {
        port.postMessage({
            action: "sendToSocket",
            data: {
                action: action,
                data: data
            }
        })
    }

    // click the "Stop generating" button
    function clickStopButton(): boolean {
        const stopGenBtn: HTMLButtonElement | null = document.querySelector("button[aria-label='Stop generating']")
        if (stopGenBtn) {
            stopGenBtn.click()
            return true
        } else {
            return false
        }
    }

    function getModelDiv(): HTMLDivElement | null {
        for (const div of document.querySelectorAll<HTMLDivElement>("div[type='button']"))
            if (div.textContent?.startsWith("ChatGPT "))
                return div
        return null
    }
    function getCurrentModel(): string {
        return getModelDiv()?.textContent ?? "ChatGPT 3.5"
    }

    function setCurrentModel(model: string) {
        if (getCurrentModel() === model) return

        // they don't have a event attached to the div for getModelDiv()
        // TODO
    }

    // conversation turns contain the nodes which we'll access later
    function getConversations(): NodeListOf<HTMLDivElement> {
        return document.querySelectorAll<HTMLDivElement>("[data-testid^='conversation-turn-']")
    }
    // returns the most recent div which represents the last message
    function getLastMessageNode(): HTMLDivElement | null {
        const conversations = getConversations()
        if (conversations.length < 1)
            return null
        else // NOTE: the last message can have multiple choices, which is why we still need to use querySelectorAll (not handled yet)
            return conversations[conversations.length - 1]?.querySelector("[data-message-author-role]") ?? null
    }

    let observer: MutationObserver | null = null

    // wait for the bot's response message node to appear, checking in intervals of 1/100th of a second
    // `excludedId` is needed in the event that the prompt is started from a nonempty chat history,
    // since the below function checks to see if the last message is written by the bot it'll return immediately
    function waitForNewMessage(tries: number, excludedId?: string | null) {
        // ~10 sec
        if (tries > 1000) {
            debugLog("ChatGPT took too long to respond")
            clickStopButton()
            return
        }

        // we need to wait until ChatGPT's response node shows up in the DOM
        // to do this we just check and wait until the last message's author is the bot
        const last = getLastMessageNode()
        if (last?.getAttribute("data-message-author-role") === "assistant"
            && last?.innerText.length > 0
            && (!excludedId || last?.getAttribute("data-message-id") !== excludedId)) {
            // start observing & transmit response back
            startObserving(last)
        } else {
            setTimeout(waitForNewMessage, 10, tries + 1, excludedId)
        }
    }
    function runPrompt(promptData: ChatRequest) {
        if (observer) {
            debugLog("Attempted to use runPrompt while observing the bot's response")
            return
        }

        const promptTextarea: HTMLTextAreaElement | null = document.getElementById("prompt-textarea") as HTMLTextAreaElement
        if (!promptTextarea) {
            debugLog("Unable to find prompt text area")
            return
        }

        // get the most recent message's message id if we know that it's from the bot, since waitForNewMessage() will automatically
        // think it's responding immediately if we don't prevent that specific message from being considered as the new message
        const last = getLastMessageNode()
        let excludedId = null
        if (last?.getAttribute("data-message-author-role") === "assistant") {
            excludedId = last.getAttribute("data-message-id")
            debugLog(`we need to exclude the most recent message since it's from the bot: ${excludedId}`)
        }

        debugLog("Using model:", promptData.model)
        setCurrentModel(promptData.model)

        // construct the prompt from the chat messages
        let prompt = ""
        if (promptData.messages.length === 1) {
            // there is guaranteed to be at least 1 message
            prompt = promptData.messages[0]!.content
        } else {
            // combine into a single string but explicitly separate with dashes
            for (let msg of promptData.messages) {
                if (msg.name)
                    prompt += `${msg.role} (${msg.name}):\n${msg.content}\n\n------------------------------\n\n`
                else
                    prompt += `${msg.role}:\n${msg.content}\n\n------------------------------\n\n`
            }
        }

        // put the prompt in the chat bar
        promptTextarea.value = prompt

        // force an input event to make the client think the user typed something
        promptTextarea.dispatchEvent(new Event(
            "input",
            { bubbles: true, cancelable: true }
        ))

        // click the send button
        ;(document.querySelector("button[data-testid='send-button']") as HTMLButtonElement).click()

        waitForNewMessage(0, excludedId)
    }

    function getContinueGeneratingBtn(): HTMLButtonElement | null {
        for (const button of document.querySelectorAll<HTMLButtonElement>("button.btn-neutral"))
            if (button.textContent === "Continue generating")
                return button
        return null
    }

    function isGenerating(): boolean {
        // TODO: update to check for "continue generating" button
        return document.querySelectorAll(".result-streaming").length + document.querySelectorAll(".result-thinking").length > 0
            || !!getContinueGeneratingBtn()
    }

    // monitor the bot's response and send updates
    let lifeCheckIntervalId: number | undefined
    function startObserving(node: HTMLDivElement) {
        if (observer) {
            debugLog("Already observing ChatGPT's response, ignoring startObserving() call")
            return
        }

        // get the conversation node for this message node
        // it's an ancestor div, and we will observe this so we can capture all possible changes
        let convNode: HTMLDivElement | null = null
        for (const conv of getConversations())
            if (conv.contains(node))
                convNode = conv
        if (!convNode) return

        port.postMessage({ action: "isGenerating", data: true })

        // keep track of the last time we got an update from the server
        // used to stop generation if ChatGPT gets stuck
        let lastChangeTimestamp = Date.now()
        let lastSeenSize = 0
        observer = new MutationObserver((_mutations : MutationRecord[]) => {
            const lastNode = getLastMessageNode()
            if (!lastNode) return

            const currentText = lastNode.innerText
            debugLog(`observer hit!: ${currentText.length} / ${lastSeenSize}`)
            if (currentText.length > lastSeenSize) {
                const chunk = currentText.slice(lastSeenSize)
                lastChangeTimestamp = Date.now()
                lastSeenSize = currentText.length
                debugLog("Got new chunk:", chunk)

                socketSend("chatChunk", chunk)
            }
        })

        debugLog("observing:")
        debugLog(node)

        // tell the server we're about to send a chat message
        socketSend("chatStart", undefined)

        // at this point, the last conversation node is ChatGPT's message
        // https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe

        observer.observe(convNode, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true
        })

        let lastContinueTimestamp: number = 0
        lifeCheckIntervalId = setInterval(() => {
            debugLog(`lifeCheck: isGenerating=${isGenerating()}, last response=${(Date.now() - lastChangeTimestamp) / 1000}`)
            const generating = isGenerating()
            port.postMessage({ action: "isGenerating", data: generating })

            let stop = false
            if ((Date.now() - lastChangeTimestamp) / 1000 > responseInactivityThreshold) {
                if (!clickStopButton())
                    debugLog("attempt generation stop: couldn't find 'Stop generating' button")
                stop = true
            } else if (!generating) {
                stop = true
            } else if ((Date.now() - lastContinueTimestamp) / 1000 > 5) {
                // it's responding, so we should check to see if "continue generating" is visible
                const continueBtn = getContinueGeneratingBtn()
                if (continueBtn && observer) {
                    debugLog("!!! CLICKED THE CONTINUE BUTTON!")
                    continueBtn.click()
                    // update lastChangeTimestamp so that it'll wait a bit longer
                    lastChangeTimestamp = lastContinueTimestamp = Date.now()
                }
            }
            if (stop) {
                const lastChunk = getLastMessageNode()?.innerText.slice(lastSeenSize) ?? ""
                socketSend("chatChunk", lastChunk)
                debugLog(`final response piece: ${lastChunk}`)
                socketSend("chatEnd", lastChunk)
                stopObserving()
            }
        }, 1000)
    }

    function stopObserving() {
        if (!observer) {
            debugLog("Attempt to disconnect observer when not running")
            return
        }

        debugLog("stopObserving()")

        port.postMessage({ action: "isGenerating", data: false })

        observer.disconnect()
        observer = null

        clearInterval(lifeCheckIntervalId)

        observer = null
        lifeCheckIntervalId = undefined
    }

    port.onMessage.addListener(message => {
        switch (message.action) {
        case "runPrompt": {
            runPrompt(message.data as ChatRequest)
            break
        }
        default: {
            debugLog("[content] Invalid action:", message.action)
            break
        }
        }
    })

    debugLog("[content] Running")
})()
