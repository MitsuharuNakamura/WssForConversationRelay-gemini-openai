//必要に応じて設定(TLSのFetchエラーが出る場合)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const WebSocket = require('ws');

const port = process.env.PORT || 9999;
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'openai';
const sentenceDelimiterRegex = /(?<=[。、？])/; // 日本語用区切り

const wss = new WebSocket.Server({ port });
console.log(`WebSocket server is running on wss://localhost:${port} (LLM: ${LLM_PROVIDER})`);

let createLLMHandler;

if (LLM_PROVIDER === 'openai') {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    createLLMHandler = () => {
        let conversationHistory = [
            { role: 'system', content: process.env.SYSTEM_PROMPT || 'あなたは親切なAIです。' }
        ];

        return async function handlePrompt(question, ws) {
            conversationHistory.push({ role: 'user', content: question });

            const stream = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: conversationHistory,
                stream: true,
            });

            let buffer = '';

            for await (const chunk of stream) {
                const message = chunk.choices[0]?.delta?.content;
                if (message) {
                    buffer += message;
                    const sentences = buffer.split(sentenceDelimiterRegex);
                    buffer = sentences.pop();
                    for (const sentence of sentences) {
                        console.log("DEBUG:", sentence);
                        ws.send(JSON.stringify({ type: 'text', token: sentence, last: false }));
                    }
                }
            }

            if (buffer) {
                console.log("DEBUG:", buffer);
                ws.send(JSON.stringify({ type: 'text', token: buffer, last: true }));
            }

            conversationHistory.push({ role: 'assistant', content: buffer });
        };
    };
} else if (LLM_PROVIDER === 'gemini') {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.0-flash',
        systemInstruction: process.env.SYSTEM_PROMPT || 'あなたは親切なAIです。'
    });

    createLLMHandler = () => {
        let history = [];

        return async function handlePrompt(question, ws) {
            const chat = model.startChat({ history });
            
            const result = await chat.sendMessageStream(question);

            let buffer = '';
            let fullResponse = '';

            for await (const chunk of result.stream) {
                const text = chunk.text();
                buffer += text;
                fullResponse += text;
                const sentences = buffer.split(sentenceDelimiterRegex);
                buffer = sentences.pop();
                for (const sentence of sentences) {
                    console.log("DEBUG:", sentence);
                    ws.send(JSON.stringify({ type: 'text', token: sentence, last: false }));
                }
            }

            if (buffer) {
                console.log("DEBUG:", buffer);
                ws.send(JSON.stringify({ type: 'text', token: buffer, last: true }));
                fullResponse += buffer;
            }

            history.push({ role: 'user', parts: [{ text: question }] });
            history.push({ role: 'model', parts: [{ text: fullResponse }] });
        };
    };
} else {
    throw new Error(`Unsupported LLM_PROVIDER: ${LLM_PROVIDER}`);
}

wss.on('connection', (ws) => {
    console.log('Client connected');
    const handlePrompt = createLLMHandler();

    ws.on('message', async (message) => {
        console.log(`Received: ${message}`);

        try {
            const parsedMessage = JSON.parse(message);
            if (parsedMessage.type === 'prompt' && parsedMessage.voicePrompt) {
                await handlePrompt(parsedMessage.voicePrompt, ws);
            } else {
                console.log("Invalid prompt format received.");
            }
        } catch (error) {
            console.error('メッセージの処理中にエラー:', error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});
