import { convertToModelMessages } from 'ai';
const msgs = [{"parts":[{"type":"text","text":"Hello"}],"id":"Vxy7zcJHcyhpojth","role":"user"}];
convertToModelMessages(msgs as any).then(res => console.log("Result:", JSON.stringify(res, null, 2)));
