// ollama.ts - this module deals with ollama

// Furhat's every word comes from here, and so does the reason behind it.

// This game is LLM only : there is no offline word list.


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. import in the two shapes we use: Message (one line of chat) and LlmReply (what the model must send back)

import { Message, LlmReply } from "./types";


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. where Ollama listens; with the ssh tunnel to mltgpu active this is localhost:11434
// 2. the same address with "/api/chat" cut off, so embeddings.ts can attach "/api/embeddings" instead
// 3. which model to use from the server ; we can override without editing code: OLLAMA_MODEL="llama3.1:8b" npx tsx src/main.ts
// 4. is this a REASONING model (deepseek-r1 and friends)? .test() gives true if the name matches any of those words

const OLLAMA_API_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/chat";
const OLLAMA_BASE_URL = OLLAMA_API_URL.replace(/\/api\/chat\/?$/, "");
export const MODEL = process.env.OLLAMA_MODEL ?? "phi3:mini";
const IS_REASONING_MODEL = /r1|reason|qwq|thinking/i.test(MODEL);


////////////////////////////////// WHY THE REASONING CHECK /////////////////////////////////////////////
//    Reasoning models think out loud inside <think>...</think> before answering.                     //
//    Ollama's format:"json" option forces the very first character to be JSON,                       //
//    Not related anymore, used in testing in the early development                                   //
//    Still want to keep though, just in case we have to use a reasoning model                        //
////////////////////////////////////////////////////////////////////////////////////////////////////////





////////////////////////////////////// THE SYSTEM PROMPT ///////////////////////////////////////////////


// The standing instructions the model sees on every call. Backticks let the text run over many lines. Asking for JSON rather than prose is what makes the reply machine readable.
// The "motivation" idea follows : the model must justify its word in the same reply, so "why?" can be answered instantly later with no second call, and the reason can be challenged.

const SYSTEM_PROMPT = `
You are playing a word association game. The human says a word, and you must
answer with EXACTLY ONE NEW common English word that is associated with it.

Your word must be DIFFERENT from the human's word. Never echo their word back.
Example: if the human says "food", a good answer is "cook" or "eat".
Answering "food" is WRONG because it just repeats them.

Rules:
- Never repeat any word that has already been used in the game history.
- Use EVERYDAY words that a ten-year-old would know, and that are easy to say
  out loud. Never answer with a rare, abstract or literary word such as
  "ephemeral", "ubiquitous" or "paradigm". The human has to recognise your
  word instantly by ear.
- Judge whether the human's word was a plausible association with the previous word.
- Give a motivation: ONE complete, standalone sentence explaining why your word
  is linked to the human's word. It will be spoken ON ITS OWN, so write a full
  sentence such as "Bees collect nectar from flowers to make honey."
  Do NOT start it with "because" and do NOT leave it empty.

Respond ONLY with a JSON object in this exact schema, and nothing else:
{"related": true, "word": "yourword", "motivation": "one standalone sentence"}
`;


////////////////////////////////////////////////////////////////////////////////////////////////////////





///////////////////////////////////// STARTUP CHECK ////////////////////////////////////////////////////


  // Asks Ollama which models it has and confirms ours is among them. Called once at startup so problems are loud and immediate
  //
  // 1.  the function; gives back true or false
  // 2.  log which model and address we are about to use : useful when sharing a transcript
  // 3.  log whether JSON mode is on
  // 4.  the ? : is a compact if/else : reasoning model means OFF, anything else means ON
  // 6.  try: if the connection fails, jump to the catch
  // 7.  ask /api/tags, which lists the installed models
  // 8.  give up after 5 seconds : fetch has NO time limit of its own, and a half dead ssh tunnel (local port still bound, remote end gone) accepts the connection and then never replies : without this the startup simply freezes with no message at all
  // 10. did the server answer with an error code?
  // 11. say which code
  // 12. report failure
  // 14. read the reply: it looks like { models: [ { name: "..." }, ... ] }
  // 15. keep only the names: ?? [] guards against a missing list, .map picks out each name
  // 16. is the list empty? server is up but has nothing installed
  // 17. say so
  // 18. report failure
  // 20. is our model there? .some gives true if at least one entry passes the test
  // 23. not found : this is the classic cause of a 404 later
  // 24. say which model is missing
  // 25. list what the server does have
  // 26. tell how to rerun with a ready-made command using the first available model
  // 28. report failure
  // 30. all good : say so
  // 31. report success
  // 32. we only get here if the connection itself failed
  // 33. say which address failed
  // 34. the usual cause is the tunnel so print the exact command to reopen it

export async function checkModel(): Promise<boolean> {
  console.log(`LLM: model "${MODEL}" at ${OLLAMA_API_URL}`);
  console.log(
    `LLM: JSON mode ${IS_REASONING_MODEL ? "OFF (reasoning model - will parse <think> output)" : "ON"}`
  );

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`LLM: server responded ${response.status} to /api/tags`);
      return false;
    }
    const data = await response.json();
    const names: string[] = (data.models ?? []).map((m: any) => m.name);

    if (names.length === 0) {
      console.error("LLM: the server has NO models installed.");
      return false;
    }

    const found = names.some(
      (n) => n === MODEL || n.split(":")[0] === MODEL.split(":")[0]
    );

    if (!found) {
      console.error(`LLM: model "${MODEL}" is NOT installed on the server.`);
      console.error(`LLM: available models are: ${names.join(", ")}`);
      console.error(`LLM: rerun with one of them. Like:`);
      console.error(`       OLLAMA_MODEL="${names[0]}" npx tsx src/main.ts`);
      return false;
    }

    console.log(`LLM: model "${MODEL}" is installed and ready.`);
    return true;
  } catch (error) {
    console.error("LLM: cannot reach Ollama at", OLLAMA_BASE_URL);
    console.error("LLM: is the ssh tunnel active? Try:");
    console.error("       ssh -f -N -p 62266 -L 11434:127.0.0.1:11434 <your_id>@mltgpu.flov.gu.se");
    return false;
  }
}


////////////////////////////////////////////////////////////////////////////////////////////////////////





/////////////////////////////////////// WARM-UP ////////////////////////////////////////////////////////


  // The very first request to a cold model is slow it better be loaded into memory before
  //
  // 1.  the function; gives nothing back (void), it just makes the model ready
  // 2.  say what is happening
  // 3.  note the start time, to report how long the load took
  // 4.  try: a failed warm-up is not fatal, so any error is swallowed below
  // 5.  build the request
  // 6.  ...the model to load
  // 7.  ...a trivial prompt, since we do not care about the answer
  // 8.  ...one complete reply rather than a stream
  // 9.  ...and num_predict: 1 asks for just one token, so the warm-up itself stays quick
  // 11. send it and wait
  // 12. POST
  // 13. the body is JSON
  // 14. the body, turned from an object into text
  // 16. report how many seconds the load took (toFixed(1) keeps one decimal)
  // 18. ...say so, but carry on : the real call will simply pay the loading cost itself

export async function warmUp(): Promise<void> {
  console.log(`LLM: warming up "${MODEL}" (loading into memory)...`);
  const started = Date.now();
  try {
    const body: Record<string, unknown> = {
      model: MODEL,
      messages: [{ role: "user", content: "hi, are you ready?" }],
      stream: false,
      options: { num_predict: 1 },
    };
    await fetch(OLLAMA_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(`LLM: warm-up done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  } catch (error) {
    console.error("LLM: warm-up failed (not fatal):", error);
  }
}


////////////////////////////////////////////////////////////////////////////////////////////////////////





///////////////////////////////// THE LOW-LEVEL CALL ///////////////////////////////////////////////////


  // One request to the model. Everything else in this file goes through here. Gives back the parsed JSON object, or null if the reply was unusable.
  //
  // 1.  the function; takes a list of chat messages, gives back a reply or null
  // 2.  build the request
  // 3.  ...model
  // 4.  ...the conversation we are sending, similar to furhat balloon task
  // 5.  ...one complete answer
  // 6.  ...and temperature 0.9, which is high : more variety in the words chosen
  // 8.  for ordinary models only
  // 9.  ...force valid JSON output (see the reasoning model note at the top)
  // 14. our request, turned into text
  // 16. anything other than 200 OK is an error
  // 17. log the status and the server's own message
  // 18. give back null : so the caller will retry
  // 20. read the reply and turn the text back into an object
  // 21. the model's actual answer lives in data.message.content
  // 22. strip any <think>...</think> block: [\s\S]*? means "any characters including newlines, as few as possible", and /g means "every one of them"
  // 23. where does the JSON object start?
  // 24. where does it end? (lastIndexOf searches from the back)
  // 25. no braces at all? then there is no JSON in there
  // 26. log the first 200 characters so you can see what it actually said
  // 27. give back null : the caller will retry
  // 29. keep only the {...} part, whatever prose surrounds it
  // 30. try: JSON.parse throws if the text is malformed
  // 31. parse it and hand it back ("as" tells TypeScript which shape to expect)
  // 32. it was not valid JSON:
  // 33. ...log what we got
  // 34. ...and give back null

async function callOllama(messages: Message[]): Promise<LlmReply | null> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: messages,
    stream: false,
    options: { temperature: 0.9 },
  };
  if (!IS_REASONING_MODEL) {
    body.format = "json";
  }

  const response = await fetch(OLLAMA_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error("Ollama API error:", response.status, await response.text());
    return null;
  }

  const data = await response.json();
  const content: string = data.message.content;

  const noThink = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = noThink.indexOf("{");
  const end = noThink.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.error("Ollama: no JSON object in reply:", content.slice(0, 200));
    return null;
  }
  const jsonText = noThink.slice(start, end + 1);

  try {
    return JSON.parse(jsonText) as LlmReply;
  } catch {
    console.error("Ollama: reply was not valid JSON:", jsonText.slice(0, 200));
    return null;
  }
}


////////////////////////////////////////////////////////////////////////////////////////////////////////





///////////////////////////////// CLEANING THE ANSWER ///////////////////////////////////////////////////


  // Models disobey phrasing instructions all the time. This cleans the motivation so it can be spoken on its own without sounding broken : "Because they go together." would otherwise come out as a fragment.
  //
  // 1. takes the raw motivation (which may be missing), gives back tidy text or undefined
  // 2. nothing there at all? then nothing to clean
  // 3. remove spaces from both ends (let, because it changes on every line below)
  // 4. strip quote marks from the start and end : ^ means start, $ means end, | means "or"
  // 5. drop a leading "because", however it is capitalised, plus any comma or space after it
  // 6. drop a trailing full stop or space, since our own sentence adds one
  // 7. squash any double spaces into single ones
  // 8. too short to be a real sentence? give back undefined, so the caller's default takes over

function cleanMotivation(raw?: string): string | undefined {
  if (!raw) return undefined;
  let m = raw.trim();
  m = m.replace(/^["']+|["']+$/g, "");
  m = m.replace(/^because\b[\s,:]*/i, "");
  m = m.replace(/[.\s]+$/g, "");
  m = m.replace(/\s+/g, " ");
  return m.length >= 3 ? m : undefined;
}


  // 1. takes the model's raw word (which may be missing), gives back one clean word or undefined
  // 2. start from the raw text; ?. means "only if it exists", so a missing word cannot crash this
  // 3. remove spaces from both ends
  // 4. lowercase it
  // 5. if it sent several words, keep only the first: "roast beans" becomes "roast"
  // 6. drop punctuation but keep digits, so the model may legitimately answer "seven" or "7"
  // 7. an empty string counts as nothing, so give back undefined in that case

function cleanWordFromLlm(raw?: string): string | undefined {
  const word = raw
    ?.trim()
    .toLowerCase()
    .split(/\s+/)[0]
    ?.replace(/[^a-z0-9]/g, "");
  return word && word.length > 0 ? word : undefined;
}


////////////////////////////////////////////////////////////////////////////////////////////////////////





//////////////////////////////////// OPENING WORD //////////////////////////////////////////////////////


  // The game always opens with the same word, so it is consistent across conditions... A varying opening word would be a confound-
  //
  // This deliberately does not ask the model. phi3:mini is a 3.8B model that ignores instructions often
  //
  // It is still async and still returns the same shape, so main.ts awaits it exactly as before and nothing else changes.
  //
  // 1. the function; gives back a reply, and never null
  // 2. start building the answer
  // 3. kept only because LlmReply requires the field; nothing reads it
  // 4. the opening word itself
  // 5. why it is a good opener, spoken only if the player asks "why?"

export async function fetchStartWord(): Promise<LlmReply | null> {
  return {
    related: true,
    word: "apple",
    motivation:
      "Apple is an everyday word that is easy to hear and easy to " +
      "find associations for.",
  };
}


////////////////////////////////////////////////////////////////////////////////////////////////////////





///////////////////////////////// THE MAIN PER-TURN CALL ///////////////////////////////////////////////


  // What the game calls on every turn. It checks the model's word and, if it is no good, retries with a correction so the model sees what it did wrong.
  // Returns null only after three failures, and then the game ends honestly.
  //
  // 1. the function, with three inputs on their own lines:
  // 2. ...the word the player just said
  // 3. ...Furhat's previous word
  // 4. ...and every word played so far
  // 5. it gives back a reply or null

export async function fetchNextWord(
  userWord: string,
  previousWord: string,
  history: string[]
): Promise<LlmReply | null> {

  // 1. describe the situation as one message from us
  // 2. role "user" : this is us talking
  // 3. the text itself:
  // 4. ...every word already used, joined by commas, which the model may not reuse
  // 5. ...what was just said by each side
  // 6. ...the TASK, phrased as an explicit instruction
  // 7. ...the two things it must not do
  // 8. ...ask for the reason as well
  // 9. ...and nothing but the JSON

  const userMessage: Message = {
    role: "user",
    content:
      `Words already used (you may NOT reuse any of these): ${history.join(", ")}\n` +
      `My previous word was "${previousWord}" and the human answered "${userWord}".\n` +
      `TASK: give me ONE new word that is associated with "${userWord}". ` +
      `It must not be "${userWord}" itself and must not be in the used list. ` +
      `Also give one standalone sentence saying why your word links to "${userWord}". ` +
      `Reply with the JSON object only.`,
  };

  // 1. the conversation we send; a retry appends to this list rather than replacing it
  // 2. the standing instructions
  // 3. the situation we just built

  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    userMessage,
  ];

  // 1.  try three times --> for (start at 0, while under 3, add 1)
  // 2.  try: a network failure jumps to the catch below
  // 3.  send everything and wait for the answer
  // 4.  clean the word it gave
  // 5.  accept it only if ALL of these hold: we got a reply, the word is not empty, it has not been used before, and it is not the player's own word
  // 6.  copy the reply with the cleaned word and tidied motivation, and we are done
  // 8.  otherwise: name what was wrong ("(nothing)" if it sent no word at all)
  // 9.  log the rejection, with which attempt this was, add the model's bad answer to the conversation
  // 11. ...followed by a correction, so the retry is a real second chance
  // 12. role "user" : us telling it off
  // 13. the correction text
  // 14. asking for a different word
  // 15. and nothing but the JSON
  // 17. a network level failure, not a bad answer
  // 18. say so, with the usual cause named
  // 19. give back null immediately : no point retrying if the tunnel is down
  // 22. three bad answers in a row : the game will end

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await callOllama(messages);
      const word = cleanWordFromLlm(reply?.word);

      if (reply && word && !history.includes(word) && word !== userWord) {
        return { ...reply, word, motivation: cleanMotivation(reply.motivation) };
      }

      const bad = reply?.word ?? "(nothing)";
      console.log(`Ollama: invalid word "${bad}" (attempt ${attempt + 1})`);
      messages.push({ role: "assistant", content: JSON.stringify(reply ?? {}) });
      messages.push({
        role: "user",
        content:
          `"${bad}" is not allowed (it repeats a used word or is empty). ` +
          `Give a DIFFERENT single word associated with "${userWord}". ` +
          `Reply with the JSON object only.`,
      });
    } catch (error) {
      console.error("Error calling Ollama:", error, "- probably ssh tunnel is not active.");
      return null;
    }
  }

  return null;
}


////////////////////////////////////////////////////////////////////////////////////////////////////////





//////////////////////////////////// WORD DEFINITIONS //////////////////////////////////////////////////


  // For when the player says "what does that mean?" about one of Furhat's own words. Gives back a short sentence, or null (the caller then just repeats the word instead of stalling).
  //
  // 1.  the function; takes the word, gives back a sentence or null
  // 2.  try: a failure jumps to the catch
  // 3.  make one call with two messages:
  // 4.  ...a different system prompt from the game one, because this is a different job
  // 5.  role "system"
  // 6.  the instructions
  // 7.  one short sentence a 10 year old would understand
  // 8.  and a different JSON shape, with just a "definition" field
  // 10. and the question itself
  // 11. role "user"
  // 12. the word we want explained
  // 15. pull out the definition field; "unknown" means we do not trust its type yet, and (reply as any) is needed because LlmReply has no "definition" field
  // 16. accept it only if it really is text and is not empty
  // 17. hand it back with the spaces trimmed
  // 19. anything else is unusable : give back null
  // 20. the call failed
  // 21. say so
  // 22. and give back null; the caller copes with it

export async function fetchDefinition(word: string): Promise<string | null> {
  try {
    const reply = await callOllama([
      {
        role: "system",
        content:
          "You explain single English words in the simplest possible terms. " +
          "Answer with ONE short sentence a ten-year-old would understand. " +
          'Respond ONLY with JSON: {"definition": "your sentence"}',
      },
      {
        role: "user",
        content: `What does the word "${word}" mean? Reply with the JSON object only.`,
      },
    ]);
    const text: unknown = (reply as any)?.definition;
    if (typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }
    return null;
  } catch (error) {
    console.error("Error fetching definition:", error);
    return null;
  }
}