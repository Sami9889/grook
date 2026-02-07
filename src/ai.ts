import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage, createAgent, createMiddleware, tool } from "langchain";
import { ConversationsInfoResponse, UsersInfoResponse } from "@slack/web-api";
import { env } from "cloudflare:workers"
import { ChatGroq } from "@langchain/groq";
import z from "zod";
import { assertString, botId } from "./core.js";
import basePrompt from "./prompt/prompt.md";
import safeguardPrompt from "./prompt/safeguard.md";
import { client } from "./core.js";
import createEmojiRegex from "emoji-regex"
import emojis from "./emojis.js";

const emojiRegex = createEmojiRegex();

const USER_ID_DESCRIPTION = "The user's member ID, or a comma-separated list of \
them. Example: U12345ABCDE,U67890FGHIJ";
const TEXT_DESCRIPTION = "The message text. To send multiple messages at once, \
place them on separate lines. Example: 'Hello, world!'";
const SKIP_DESCRIPTION = "If true, `skip` will be called after the message is \
sent, ending the agent turn without a response."

const llm = new ChatGroq({
    model: env.GROQ_MODEL,
    temperature: 0.4,
});

const llmSafeguard = new ChatGroq({
    model: env.GROQ_SAFEGUARD_MODEL,
    temperature: 0,
});

function error(message: string, ...data: unknown[]): string {
    console.log("Tool error:", message, { data });
    return message;
}

function skip(message: string) {
    console.log("Skip", message);
    return "_skip";
}

function handle(err: any) {
    if (err instanceof Error && err.message.includes("API error")) {
        const message = `Slack API error: ${err.message}`;
        console.error(message);
        return message;
    }
    console.error("Other error:", err);
    throw err;
}

const skipTool = tool(
    function() {
        return skip("skip");
    },
    {
        name: "skip",
        description: "Immediately end the assistant turn without responding \
to the user. Use this when the input message is irrelevant or when you have \
already called send_channel_message and do not want to send another message.",
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
            if (input.skip_response) return skip("send_dm");
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
            skip_response: z.boolean().describe(SKIP_DESCRIPTION),
        }),
    }
)

const sendChannelMessage = tool(
    async function(input, config) {
        try {
            const channel: string = config.configurable.channel;
            const thread_ts: string = config.configurable.thread_ts;
            input.text = await safeguard(input.text);
            for (const line of input.text.split("\n")) {
                if (!line) continue;
                client.chat.postMessage({
                    channel,
                    thread_ts,
                    reply_broadcast: true,
                    text: line
                });
            }
            if (input.skip_response) return skip("send_channel_message");
            return "success";
        } catch(err) {
            return handle(err);
        }
    },
    {
        name: "send_channel_message",
        description: "Send a top-level message in both the current channel and the current thread.",
        schema: z.object({
            text: z.string().describe(TEXT_DESCRIPTION),
            skip_response: z.boolean().describe(SKIP_DESCRIPTION),
        }),
    }
)

const react = tool(
    async function(input, config) {
        try {
            const channel: string = config.configurable.channel;
            const ts: string = config.configurable.ts;
            const nonexistent: string[] = [];
            const reactions: string[] = [];
            for (let emoji of input.emojis) {
                emoji = emoji.trim();
                if (!emoji) continue;
                if (!emoji.match(emojiRegex)) {
                    reactions.push(emoji);
                    continue;
                }
                const reaction = emojis[emoji];
                if (!reaction) {
                    nonexistent.push(emoji);
                    continue;
                }
                reactions.push(reaction);
            }
            if (nonexistent.length) {
                return error(`Emojis invalid or unavailable: ${nonexistent.join(", ")}`, input);
            }
            const promises: Promise<unknown>[] = [];
            console.log("react", {
                input,
                reactions,
            });
            console.log("Creating reaction promises");
            for (let reaction of reactions) {
                reaction = reaction.trim();
                if (!reaction) continue;
                promises.push(client.reactions.add({
                    channel,
                    timestamp: ts,
                    name: reaction,
                }));
            }
            console.log("Awaiting reaction promises");
            await Promise.all(promises);
            if (input.skip_response) return skip("react");
            return `Reacted with ${reactions.join(", ")}`
        } catch(err) {
            return handle(err);
        }
    },
    {
        name: "react",
        description: "React to the most recent message.",
        schema: z.object({
            emojis: z.array(z.string().nonempty()).min(1).nonempty().describe(
                'The reaction(s) to add, in separate strings. Emojis should \
either be Unicode emojis (e.g. "😀") or Slack emoji names without surrounding \
colons (e.g. "grinning").'
            ),
            skip_response: z.boolean().describe(SKIP_DESCRIPTION),
        })
    }
)

const tools = [
    skipTool,
    getProfile,
    sendDM,
    sendChannelMessage,
    react,
]

const prompt = basePrompt
    .replaceAll("{BOT_ID}", botId)
    .replaceAll("{CREATOR}", env.CREATOR_ID
        ? ` You were created by the user with ID ${env.CREATOR_ID}.`
        : ""
    );

const handleSkipMiddleware = createMiddleware({
    name: "HandleSkip",
    beforeModel: {
        canJumpTo: ["end"],
        hook(state) {
            const lastMessage = state.messages.at(-1);
            if (lastMessage instanceof ToolMessage && lastMessage.content == "_skip") {
                return {
                    messages: [new AIMessage("")],
                    jumpTo: "end",
                }
            }
        }
    }
})

const agent = createAgent({
    model: llm,
    middleware: [handleSkipMiddleware],
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
    configurable: { channel: string, thread_ts: string | undefined, ts: string }
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
    let prompt = "Relevant IDs (U = User, C/D = Channel):\n";
    for (const [key, value] of Object.entries(relevantIDs)) {
        prompt += `${key}: ${value}\n`
    }
    const addedMessage = new SystemMessage(prompt);
    const result = await agent.invoke({
        messages: messages.concat([addedMessage])
    }, { configurable });
    const lastMessage = result.messages.at(-1);
    if (lastMessage instanceof AIMessage) {
        assertString(lastMessage.content);
        return await safeguard(lastMessage.content);
    }
    throw new TypeError(`Expected AIMessage, got ${lastMessage}`);
}