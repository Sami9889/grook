import { AIMessage, BaseMessage, HumanMessage, SystemMessage, createAgent, tool } from "langchain";
import { ConversationsInfoResponse, UsersInfoResponse } from "@slack/web-api";
import { env } from "cloudflare:workers"
import { ChatGroq } from "@langchain/groq";
import z from "zod";
import { assertString, botId } from "./core.js";
import basePrompt from "./prompt/prompt.md";
import safeguardPrompt from "./prompt/safeguard.md";
import { client } from "./core.js";

class Skip extends Error {}

const USER_ID_DESCRIPTION = "The user's member ID, or a comma-separated list of \
them. Example: U12345ABCDE,U67890FGHIJ";
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
            const result = await client.users.info({ user: input.user_id });
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
            const response = await client.conversations.open({
                users: input.user_id
            });
            const channel = response.channel?.id;
            if (!channel) {
                return error("Couldn't open conversation - are you sure that user exists?");
            }
            for (const line of input.text.split("\n")){
                if (!line) continue;
                client.chat.postMessage({
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
                client.chat.postMessage({
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

const react = tool(
    async function(input, config) {},
    {
        name: "react",
        description: "React to the most recent message.",
        schema: z.object({
            name: z.array(z.string()).min(1).nonempty().describe(
                "The reaction(s) to add to the message (without surrounding colons)."
            ),
            done: z.boolean().describe(DONE_DESCRIPTION)
        })
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
    configurable: { channel: string }
): Promise<string> {
    const channel = configurable.channel.toUpperCase();
    const relevantIDs: Record<string, string> = {};
    for (const message of messages) {
        assertString(message.content);
        const matches: string[] = message.content.match(/\b(u|c|d)[a-z0-9]{10}\b/gi) ?? [];
        if (!(channel in relevantIDs)) {
            matches.push(channel);
        }
        for (let match of matches) {
            match = match.toUpperCase();
            if (match in relevantIDs) {
                continue;
            }
            if (match.startsWith("C") || match.startsWith("D")) {
                let result: ConversationsInfoResponse;
                try {
                    result = await client.conversations.info({ channel: match });
                } catch (err) {
                    console.error(err);
                    relevantIDs[match] = "unknown/nonexistent/private";
                    continue;
                }
                if (match == channel) {
                    match += " (current channel)";
                }
                relevantIDs[match] = result.channel.name ?? "direct message";
                continue;
            }
            let result: UsersInfoResponse;
            try {
                result = await client.users.info({ user: match });
            } catch (err) {
                console.error(err);
                relevantIDs[match] = "unknown/nonexistent";
                continue;
            };
            const profile = result.user.profile;
            relevantIDs[match] = profile.display_name || profile.real_name;
        }
    }
    console.log("Relevant IDs:", relevantIDs)
    let prompt = "Relevant IDs (U = User, C = Channel):\n";
    for (const [key, value] of Object.entries(relevantIDs)) {
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