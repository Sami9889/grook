import { AIMessage, BaseMessage, HumanMessage, SystemMessage, createAgent, tool } from "langchain";
import { env } from "cloudflare:workers"
import { ChatGroq } from "@langchain/groq";
import z from "zod";
import { app, assertString, botId } from "./core.js";
import basePrompt from "./prompt/prompt.md";
import safeguardPrompt from "./prompt/safeguard.md";

class Skip extends Error {}

const USER_ID_DESCRIPTION = "The user's member ID. Example: U12345ABCDE";
const TEXT_DESCRIPTION = "The message text. To send multiple messages at once, \
place them on separate lines. Example: 'Hello, world!'";
const DONE_DESCRIPTION = "If true, `skip` will be called after the message is \
sent."

const llm = new ChatGroq({
    model: env.GROQ_MODEL,
    temperature: 0.4,
});

const llmSafeguard = new ChatGroq({
    model: env.GROQ_SAFEGUARD_MODEL,
    temperature: 0,
});

function error(message: string): string {
    console.log("Tool error:", message);
    return message;
}

function handle(err: any) {
    console.error(err);
    if (err instanceof Error && err.message.includes("API error")) {
        return `Slack API error: ${err.message}`;
    }
    throw err;
}

const skip = tool(
    function(_input) {
        throw new Skip();
    },
    {
        name: "skip",
        description: "Immediately end the assistant turn without responding \
to the user.",
        schema: z.object({}),
    }
);

const getProfile = tool(
    async function(input) {
        try {
            const result = await app.client.users.info({ user: input.user_id });
            const profile = result.user?.profile;
            if (!profile) return error("No profile received");
            for (const key in profile) {
                if (key.startsWith("image_")) {
                    delete profile[key as keyof typeof profile];
                }
            }
            return profile;
        } catch(err) {
            return handle(err);
        }
    },
    {
        name: "get_profile",
        description: "Get information about a user such as their name.",
        schema: z.object({
            user_id: z.string().describe(USER_ID_DESCRIPTION),
        }),
    }
);

const sendDM = tool(
    async function(input) {
        try {
            if (!input.text.match(/<@u[a-z0-9]{10}>/gi)) {
                return error("Text must mention the person who requested the DM")
            }
            input.text = await safeguard(input.text);
            console.log(`Sending '${input.text}' to ${input.user_id}`)
            const response = await app.client.conversations.open({
                users: input.user_id
            });
            const channel = response.channel?.id;
            if (!channel) {
                return error("Couldn't open conversation - are you sure that user exists?");
            }
            for (const line of input.text.split("\n")){
                if (!line) continue;
                app.client.chat.postMessage({
                    channel,
                    text: line,
                })
            }
            if (input.done) throw new Skip();
            return "success";
        } catch(err) {
            return handle(err);
        }
    },
    {
        name: "send_direct_message",
        description: "Send a direct message to a user.",
        schema: z.object({
            user_id: z.string().describe(USER_ID_DESCRIPTION),
            text: z.string().describe(TEXT_DESCRIPTION),
            done: z.boolean().describe(DONE_DESCRIPTION),
        }),
    }
)

const sendChannelMessage = tool(
    async function(input, config) {
        try {
            const channel: string = config.configurable.channel;
            for (const line of input.text.split("\n")) {
                if (!line) continue;
                app.client.chat.postMessage({
                    channel,
                    text: line
                });
            }
            if (input.done) throw new Skip();
            return "success";
        } catch(err) {
            return handle(err);
        }
    },
    {
        name: "send_channel_message",
        description: "Send a top-level message in the current channel.",
        schema: z.object({
            text: z.string().describe(TEXT_DESCRIPTION),
            done: z.boolean().describe(DONE_DESCRIPTION),
        }),
    }
)

const tools = [
    skip,
    getProfile,
    sendDM,
    sendChannelMessage,
]

const prompt = basePrompt
    .replaceAll("{BOT_ID}", botId)
    .replaceAll("{CREATOR}", env.CREATOR_ID
        ? ` You were created by the user with ID ${env.CREATOR_ID}.`
        : ""
    );

const agent = createAgent({
    model: llm,
    tools,
    systemPrompt: prompt,
});

const agentSafeguard = createAgent({
    model: llmSafeguard,
    systemPrompt: safeguardPrompt,
});

async function safeguard(message: string): Promise<string> {
    const result = await agentSafeguard.invoke({ messages: [new HumanMessage(message)] });
    const lastMessage = result.messages.at(-1);
    if (!(lastMessage instanceof AIMessage)) {
        throw new TypeError(`Expected AIMessage, got ${lastMessage}`);
    }
    const response = lastMessage.content;
    assertString(response);
    if (response.trim().toLowerCase() == "safe") {
        return message
    }
    console.log(`Blocked ${message}: ${response}`)
    return "This message was blocked by the content filter";
}

export async function invoke(
    messages: BaseMessage[],
    configurable: Record<string, any> = {}
): Promise<string> {
    const userIDs: Record<string, string> = {};
    for (const message of messages) {
        assertString(message.content);
        const matches = message.content.match(/u[a-z0-9]{10}/gi) ?? [];
        for (let match of matches) {
            match = match.toUpperCase();
            if (match in userIDs) {
                continue;
            }
            const result = await app.client.users.info({ user: match });
            if (!result.user) {
                userIDs[match] = "unknown/nonexistent";
                continue;
            };
            const profile = result.user.profile;
            userIDs[match] = profile.display_name || profile.real_name;
        }
    }
    console.log("Relevant users:", userIDs)
    let prompt = "Relevant IDs (U = User):\n";
    for (const [key, value] of Object.entries(userIDs)) {
        prompt += `${key}: ${value}\n`
    }
    const addedMessage = new SystemMessage(prompt);
    try {
        const result = await agent.invoke({
            messages: messages.concat([addedMessage])
        }, { configurable });
        const lastMessage = result.messages.at(-1);
        if (lastMessage instanceof AIMessage) {
            assertString(lastMessage.content);
            return await safeguard(lastMessage.content);
        }
        throw new TypeError(`Expected AIMessage, got ${lastMessage}`);
    } catch(err) {
        if (err instanceof Skip) {
            return "";
        }
        throw err;
    } 
}