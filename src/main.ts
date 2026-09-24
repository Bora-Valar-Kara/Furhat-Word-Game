// main.ts - this module is the game itself: the whole conversation, written as an XState state machine. 
//
// The normal flow:
//   setup -> attend -> greet -> listenReady -> startGame -> listenWord
//   -> processWord -> checkRelated -> acceptWord -> think -> respond
//   -> checkClock -> listenWord (round and round)
//
// with detours when the player asks "why?", does not know a word, or plays
// something the embedding check thinks is unrelated. The 5 minute clock
// (checkClock) is what ends a session.


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. the four XState pieces we use:
//      setup       ;   declares the types and actors before building the machine
//      createActor ;   brings a finished machine to life
//      fromPromise ;   wraps an async job so a state can "invoke" it
//      assign      ;   the only allowed way to change/adjust the context
// 2. our own data shapes
// 3. the robot, and the voice name it speaks with
// 4. the LLM functions, there are five:
// 5. ...the per-turn word
// 6. ...the opening word
// 7. ...the startup check
// 8. ...the warm-up
// 9. ...and word definitions
// 11. the transcript file path (to log at the end) and logTurn
// 12. the relatedness check
// 13. and its three pieces
// 15. the gaze deck: the delays measured from the pilot recording

import { setup, createActor, fromPromise, assign } from "xstate";
import { GameContext, LlmReply } from "./types";
import { realFurhat, VOICE_NAME } from "./furhat";
import { fetchNextWord, fetchStartWord, checkModel, warmUp, fetchDefinition } from "./ollama";
import { transcriptPath, logTurn } from "./transcript";
import { relatedness, checkEmbeddingModel, RELATEDNESS_THRESHOLD } from "./embeddings";
import { startSession, drawLookBackMs, sessionSummary } from "./gazedeck";


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. the robot. Everything below says "furhat", not "realFurhat", so swapping in a different implementation later means changing this one line
// 2. the shortest thing we accept as a played word. Recognizers mangle short words badly...
// 3. how long a game runs: 5 x 60 x 1000 milliseconds, written out so the 5 is easy to change if wanted

const furhat = realFurhat;
const MIN_WORD_LENGTH = 3;
const GAME_LENGTH_MS = 5 * 60 * 1000;


////////////////////////////////////////////////////////////////////////////////////////////////////////


//////////////////////////////////// SMALL HELPERS /////////////////////////////////////////////////////


// Recognizers usually return numbers as digits ("4"), not as words ("four").
// We convert them for three reasons: the embedding model gives a more meaningful vector for "four" than for the character "4"; the already used check then treats "4" and "four" as the same word; and Furhat's speech sounds the same either way. Anything larger than this table stays as digits.
// 1. the lookup table; Record<string, string> "text in, text out"
const NUMBER_WORDS: Record<string, string> = {
  "0": "zero",      "1": "one",       "2": "two",       "3": "three",
  "4": "four",      "5": "five",      "6": "six",       "7": "seven",
  "8": "eight",     "9": "nine",      "10": "ten",      "11": "eleven",
  "12": "twelve",   "13": "thirteen", "14": "fourteen", "15": "fifteen",
  "16": "sixteen",  "17": "seventeen","18": "eighteen", "19": "nineteen",
  "20": "twenty",   "30": "thirty",   "40": "forty",    "50": "fifty",
  "60": "sixty",    "70": "seventy",  "80": "eighty",   "90": "ninety",
  "100": "hundred", "1000": "thousand",
};


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. "4" -> "four"
// 2. look it up; ?? : "if it is not in the table, keep it as it was"
function digitsToWord(token: string): string {
  return NUMBER_WORDS[token] ?? token;
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// Grammatical filler that should be never somebody's answer. 
// 1.  the set; a Set is a list built for fast "is this in it?" checks
// 2   possessives, verbs, articles, prepositions and so on
// 12. backchannels and hesitation noises
// 13. noises
const STOPWORDS = new Set([
  "my","your","our","their","his","her","its",
  "word","words","answer","answers","say","said","says","tell","told",
  "i","you","he","she","it","we","they","me","him","them",
  "is","are","was","were","be","been","am","do","does","did","will","would",
  "can","could","should","may","might","must","have","has","had",
  "the","a","an","this","that","these","those",
  "and","or","but","so","then","than","too","also",
  "of","to","in","on","at","for","with","from","by","about",
  "next","now","ok","okay","well","like","just",
  "um","uh","er","erm","hmm","hm","mhm","mm","mmm","mhmm","uhu","uhhuh",
  "aha","ah","oh","eh","huh","yeah","yep","yup","right","sure",
]);


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. repair markers: when someone corrects a mishearing they announce it ("I said duck", "my word is celery"), and the intended word come straight after the marker.
// "Did you say X" clarification request somewhat manipulates this phrases.
const REPAIR_MARKER = /\b(i said|i meant|i mean|my word is|the word is|word was)\b/i;


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// Turn a raw utterance into one clean word. Three steps, each added after a real failure in testing:
//
//   1. keep only what follows a repair marker: "I said duck not dark" -> "duck not dark"
//   2. cut at "not", because what follows it is the word being rejected: -> "duck"
//   3. walk backwards and take the first token that is not filler
//
//   Taking simply the last word gave "dark" : the very word being corrected.
//
// 1.  the function; text in, one word out
// 2.  lowercase it once (let, because it is trimmed down below)
// 3.  is there a repair marker?
// 4.  if so...
// 5.  ...keep only what comes after it (.slice cuts from a position onwards)
// 7.  is there a "not"?
// 8.  if so, and it is not the very first word...
// 9.  ...drop everything from there on
// 11. now split into tokens...
// 12. ...one entry per spoken word
// 13. ...strip punctuation, keeping letters and digits
// 14. ...and discard anything left empty
// 15. walk from the end towards the start; the answer is normally last
// 16. the first token that is not filler wins
// 17. hand it back, converting digits to words on the way out
// 20. the whole utterance was filler : treated as "not caught"
function cleanWord(utterance: string): string {
  let text = utterance.toLowerCase();
  const marker = text.match(REPAIR_MARKER);
  if (marker && marker.index !== undefined) {
    text = text.slice(marker.index + marker[0].length);
  }
  const notMatch = text.match(/\bnot\b/);
  if (notMatch && notMatch.index !== undefined && notMatch.index > 0) {
    text = text.slice(0, notMatch.index);
  }
  const tokens = text
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 0);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!STOPWORDS.has(tokens[i])) {
      return digitsToWord(tokens[i]);
    }
  }
  return "";
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. is this long enough to be a real answer?
// 3. pure digits are a legitimate answer at any length, so they skip the rule
// 4. ordinary words need three letters or more
function isPlayableWord(word: string): boolean {
  if (word.length === 0) return false;
  if (/^[0-9]+$/.test(word)) return true;
  return word.length >= MIN_WORD_LENGTH;
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// Does the utterance contain any of these words or phrases as WHOLE WORDS?
// This uses \b (a word boundary) rather than a plain .includes(), and the difference matters: .includes("how") would also fire on "howl", a perfectly good answer to "owl", and the game would explain itself instead of accepting the word.
//
// 1. the function; an utterance and a list of phrases in, true or false out
// 2. lowercase it once
// 3. .some gives true if at least one phrase passes the test
// 4. build the pattern: \b at each end means whole word only, "i" means capital letters do not matter
// 5. does it appear?
function containsAny(utterance: string, phrases: string[]): boolean {
  const text = utterance.toLowerCase();
  return phrases.some((phrase) => {
    const pattern = new RegExp(`\\b${phrase}\\b`, "i");
    return pattern.test(text);
  });
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// Did the player ask what our word means? A third, separate need: not "say it again" and not "justify it", but "I don't know that word". Checked before the other two, because these phrases contain "what" and would otherwise be swallowed by them.
//
// 1. the function
// 2. the list of phrases that mean "what does it mean?"
// 3. note that "what do you mean" is deliberately not here : that is a why question, and it is in the next list instead
function wantsDefinition(utterance: string): boolean {
  return containsAny(utterance, [
    "what is that",
    "what's that",
    "what is it",
    "what's it",
    "what does it mean",
    "what does that mean",
    "what that means",
    "what it means",
    "what does .* mean",
    "meaning",
    "define",
    "definition",
    "never heard",
    "don't know that",
    "do not know that",
    "dont know that",
    "unfamiliar",
  ]);
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// Did the player ask us to justify our word? Checked before wantsRepeat, so multi word phrases containing "what" land here rather than being treated as "I didn't hear you".
// same structure
function wantsWhy(utterance: string): boolean {
  return containsAny(utterance, [
    "why",
    "how",
    "how come",
    "how is",
    "how are",
    "how does",
    "what do you mean",
    "what does that mean",
    "what is the connection",
    "what's the connection",
    "explain",
    "reason",
    "motivation",
    "justify",
    "related",
    "connection",
    "makes no sense",
    "make no sense",
    "no sense",
    "nonsense",
  ]);
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// Did the player simply not hear us? "What?" after a one word answer almost always means "say that again", not "justify yourself". Checked after wantsWhy, so the longer "what do you mean" phrases are already taken.
// same
function wantsRepeat(utterance: string): boolean {
  return containsAny(utterance, [
    "what",
    "sorry",
    "pardon",
    "come again",
    "huh",
    "say that again",
    "say it again",
    "repeat",
    "again",
    "hear",
    "catch",
    "one more time",
    "louder",
  ]);
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// During a challenge: did the player reject our reasoning?
// same
function saysDisagree(utterance: string): boolean {
  return containsAny(utterance, [
    "no", "nope", "nah", "not really", "not related", "not sure",
    "disagree", "invalid", "wrong", "incorrect", "unrelated",
    "i guess not", "not valid",
  ]);
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// During a challenge: did the player accept, or stand by their answer?
function saysAgree(utterance: string): boolean {
  return containsAny(utterance, [
    "yes", "yeah", "yep", "yup", "sure", "certainly", "definitely",
    "of course", "absolutely", "okay", "ok", "fine", "valid",
    "i think so", "i am sure", "i'm sure", "i stand by",
    "they are", "it is", "related", "connected", "connection",
    "sound alike", "sounds alike", "similar",
  ]);
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// Is the player agreeeing with Furhat's doubt rather than standing by their word? "Yeah, you're right" and "Yes, I'm sure" both start with "yeah" but mean opposite things. So these must be checked before saysAgree, which would otherwise see the "yeah" and wrongly accept the word.
function concedesToFurhat(utterance: string): boolean {
  return containsAny(utterance, [
    "you are right", "you're right", "youre right",
    "you are correct", "you're correct", "youre correct",
    "you have a point", "you've got a point",
    "good point", "fair point", "fair enough",
    "i was wrong", "i am wrong", "i'm wrong",
    "my bad", "my mistake", "i guess not", "i suppose not",
    "you win", "true", "yeah true", "that's true", "thats true",
  ]);
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. did the reply contain both a yes-ish and a no-ish word ("no yeah")?
// 2. if so we genuinely cannot tell, we ask again
function isAmbiguousVerdict(utterance: string): boolean {
  return saysAgree(utterance) && saysDisagree(utterance);
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. does the reply explicitly announce a repair : "I said cake"?
// 2. stronger evidence than a short reply, and checked before yes/no because "yes, I said cake" is a correction with a "yes" attached, not agreement
function hasRepairMarker(utterance: string): boolean {
  return /\b(i said|i meant|i mean|my word is|the word is|word was)\b/i
    .test(utterance.toLowerCase());
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. is the reply a plain yes/no rather than a word?
// 2. "yes" is three letters and would otherwise sail through every check and be played as a corrected word : this is what stops that
function isJustAnAnswer(utterance: string): boolean {
  return saysAgree(utterance) || saysDisagree(utterance) ||
         concedesToFurhat(utterance);
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// Is this reply a correction rather than a verdict? Only two things count:
// an explicit marker, or a reply short enough to be just the word itself.
// Without this, a long sentence like "they are related, they sound alike"
// would have its last word mined out and played as a new answer.
//
// 2. lowercase it once
// 3. an explicit repair marker anywhere in the sentence...
// 4. ...means yes
// 6. otherwise split into words...
// 7. ...and accept only if there are at most two, basically just the word
function looksLikeCorrection(utterance: string): boolean {
  const text = utterance.toLowerCase();
  if (/\b(i said|i meant|i mean|my word is|the word is|word was)\b/.test(text)) {
    return true;
  }
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length <= 2;
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// Turn the stored motivation into a proper standalone sentence : a capital at
// the front, exactly one full stop at the end. Needed because the motivation
// is spoken on its own, and the model sometimes ends it with a full stop and
// sometimes does not : which would give "stories.." or "stories Do you".
//
// 2. nothing
// 3. trim spaces and drop any trailing full stops
// 4. it was only punctuation
// 5. first letter upper case, the rest unchanged, then exactly one full stop
function asSentence(text: string): string {
  if (!text) return "";
  const trimmed = text.trim().replace(/[.\s]+$/, "");
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1) + ".";
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. has the game clock run out?
// 2. compare "now" against the moment play began
function timeIsUp(context: GameContext): boolean {
  return Date.now() - context.gameStartMs >= GAME_LENGTH_MS;
}

////////////////////////////////////////////////////////////////////////////////////////////////////////


////////////////////////////////////////// THE STATE MACHINE ///////////////////////////////////////////


// setup({...}) declares the machine's ingredients; .createMachine({...}) further down describes the actual states and the arrows between them.
//
// 1. start declaring
// 2. tell XState what our memory looks like
// 3. ...it is a GameContext ("as" means "treat it as this shape")

const gameMachine = setup({
  types: {
    context: {} as GameContext,
  },

/////////////////////////////////////////////// ACTORS ////////////////////////////////////////////////

  // "actors" are the async jobs a state can run: talk, listen, call the model. 
  // fromPromise wraps an async function so XState can await it and then fire onDone (it worked) or onError (it did not).
  //
  // 1. the list of actors
  // 2. set the voice, once at startup
  // 3. look at the closest person
  // 4. speak a given text; "input" is how a state passes data to an actor, and the "{ input }: { input: {...} }" part unpacks the argument & tells TypeScript its shape at the same time
  // 5. just forward the text to the robot
  // 7. listen once, and give back what was heard

  actors: {
    fhSetVoice: fromPromise(async () => furhat.setVoice(VOICE_NAME)),
    fhAttend: fromPromise(async () => furhat.attendUser()),
    fhSpeak: fromPromise(async ({ input }: { input: { text: string } }) =>
      furhat.say(input.text)
    ),
    fhListen: fromPromise(async () => furhat.listen()),

    // The thinking job for one turn. If the model cannot answer this gives back null and the game ends 
    //
    // 4.  the shape of the input
    // 6.  it gives back both the answer and a score
    // 7.  break eye contact NOW, at the moment thinking starts. NOT awaited:
    // 8.  the glance and the model call happen together, so the look away
    // 9.  covers the wait instead of adding to it
    // 11. ask the model (this is the part that takes a second or two)
    // 12. the word the player just played
    // 13. our previous word, which they associated from
    // 14. the whole chain so far
    // 16. hand back the reply; ownScore is -1 because the behaviour that used it was removed, and it is kept only so the shape stays the same

    think: fromPromise(
      async ({
        input,
      }: {
        input: { userWord: string; currentWord: string; history: string[] };
      }): Promise<{ reply: LlmReply | null; ownScore: number }> => {
        furhat.lookAway().then((p) =>
          console.log(`GAZE: looking away to ${p.x},${p.y},${p.z} while thinking`)
        );
        const reply = await fetchNextWord(
          input.userWord,
          input.currentWord,
          input.history
        );
        return { reply, ownScore: -1 };
      }
    ),

    // Speak, optionally after a short pause. 
    // The pause is what reproduces the turns where the eyes arrive BEFORE the voice: 
    // the gaze returns, a beat passes, then the word comes out. 
    // Without it a negative card from the gaze deck would be silently flattened to zero.
    //
    // 1. the actor
    // 2. it takes the text and how long to wait
    // 3. only wait if there is something to wait for
    // 4. wait
    // 6. then speak

    fhSpeakAfter: fromPromise(
      async ({ input }: { input: { text: string; waitMs: number } }) => {
        if (input.waitMs > 0) {
          await new Promise((r) => setTimeout(r, input.waitMs));
        }
        return furhat.say(input.text);
      }
    ),

    // ask the model for the word Furhat opens the game with

    startWord: fromPromise(async (): Promise<LlmReply | null> => fetchStartWord()),

    // Explain one of Furhat's own words when the player does not know it,
    // then say the word again so they can answer it. 
    //
    // 1. the actor, taking the word to explain
    // 2. ask the model
    // 3. did we get one?
    // 4. say it, then repeat the word so they can answer it
    // 5. otherwise...
    // 6. ...at least repeat the word rather than stalling

    define: fromPromise(async ({ input }: { input: { word: string } }) => {
      const definition = await fetchDefinition(input.word);
      if (definition) {
        await furhat.say(`${definition} So, ${input.word}.`);
      } else {
        await furhat.say(`Sorry, I can't explain it right now. My word is ${input.word}.`);
      }

    
    }),

    // Measure how related the player's word is to ours, using embeddings.
    // Gives back the cosine score.
    //
    // 1. the actor
    // 2. it takes the two words
    // 3. score them
    // 4. no score?
    // 5. say so, and that we are allowing the word anyway
    // 6. otherwise...
    // 7. ...work out the verdict...
    // 8. ...and print the measurement, so you can calibrate while playing:
    // 9. every turn shows the pair, the number and the verdict
    // 12. hand the score back
    
    judgeRelatedness: fromPromise(
      async ({ input }: { input: { userWord: string; ourWord: string } }) => {
        const score = await relatedness(input.ourWord, input.userWord);
        if (score === null) {
          console.log(`RELATEDNESS: ${input.ourWord} -> ${input.userWord} = (unavailable, allowing)`);
        } else {
          const verdict = score < RELATEDNESS_THRESHOLD ? "BELOW threshold" : "ok";
          console.log(

    
            `RELATEDNESS: ${input.ourWord} -> ${input.userWord} = ` +
            `${score.toFixed(3)} (threshold ${RELATEDNESS_THRESHOLD}) ${verdict}`
          );
        }
        return score;
      }
    ),
  },


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. building the machine itself

}).createMachine({

// Every fresh game starts with this empty memory.
//
// 1.  the starting context
// 2.  no word chosen yet
// 3.  filled in every time Furhat picks a word
// 4.  no words played yet
// 5.  no exchanges yet
// 6.  nothing heard yet
// 7.  no pending reply
// 8.  set when play actually begins, in startGame
// 9.  the word being judged this turn
// 10. its relatedness score
// 11. the gaze delay, drawn fresh for every answer
// 12. -1 means "not measured"
// 13. no failed attempts on this turn yet
// 14. nobody has scored yet

  context: {
    currentWord: "",
    currentMotivation: "",
    history: [],
    rounds: 0,
    lastResult: "",
    nextReply: null,
    gameStartMs: 0,
    pendingUserWord: "",
    lastScore: 0,
    lookBackMs: 0,
    ownScore: -1,
    relatedAttempts: 0,
    userScore: 0,
    furhatScore: 0,
  },

// 1. name of machine
// 2. initial state

  id: "wordgame",
  initial: "setup",


////////////////////////////////////////////// THE STATES //////////////////////////////////////////////

  states: {

    // 1. STATE 1 : one-time setup, choose the voice
    // 2. runs a job
    // 3. which job
    // 4. when it finishes, go to "attend"
    // 5. even if it fails, keep going : a wrong voice must not stop the game

    setup: {
      invoke: {
        src: "fhSetVoice",
        onDone: { target: "attend" },
        onError: { target: "attend" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 2 : look at the player
    attend: {
      invoke: {
        src: "fhAttend",
        onDone: { target: "greet" },
        onError: { target: "greet" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 3 : explain the rules
    // 2. run the speaking job
    // 3. input can be a function of the context; here it is fixed text the + signs just join the pieces into one long sentence
    // 14. done talking: go and listen
    // 15. listen even if speaking failed
    greet: {
      invoke: {
        src: "fhSpeak",
        input: {
          text:
            "Hello! My name is Furhat. We will play a word game. " +
            "I say a word, and you answer with a word that relates to it. " +
            "For example, if I say apple you can say banana. " +
            "Then I answer your word, and we keep going back and forth. " +
            "You can ask me why I chose a word, and if you don't accept my " +
            "explanation, you get a point. And the same goes for me! " +
            "We will play for 5 minutes. I can start if you are ready. " +
            "Are you ready?",
        },
        onDone: { target: "listenReady" },
        onError: { target: "listenReady" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 4 : hear whether they are ready
    // 2. listen once
    // 3. whatever they say, we start. There is deliberately NO "no" branch:
    //    the old check matched the letters "no" anywhere, so "now", "know"
    //    and "no problem, I'm ready" all cancelled the game
    // 4. a recognition hiccup: just listen again
    listenReady: {
      invoke: {
        src: "fhListen",
        onDone: { target: "startGame" },
        onError: { target: "listenReady" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 5 : ask the model for the opening word
    // 2. start the clock the moment real play begins
    // 3. run the opening word job
    // 4. a list of transitions, checked top to bottom; the first whose guard is true wins
    // 5. no word at all? say so
    // 6. otherwise...
    // 7. ...go and announce it
    // 8. ...and remember it. assign() is the only way to change the memory
    startGame: {
      entry: assign(() => ({ gameStartMs: Date.now() })),
      invoke: {
        src: "startWord",
        onDone: [
          { guard: ({ event }) => event.output?.word == null, target: "llmUnavailable" },
          {
            target: "sayStartWord",
            actions: assign(({ event }) => {
              const reply = event.output as LlmReply;
              const word = reply.word as string;
              return {
                currentWord: word,
                currentMotivation:
                  reply.motivation ?? "I think it is a nice and simple word to start with.",
                history: [word],
                rounds: 0,
              };
            }),
          },
        ],
        onError: { target: "llmUnavailable" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 5b : announce the opening word
    // 3. here input is a function of the context, so the sentence is built fresh; the backticks and ${...} insert the current word
    // listen on done
    sayStartWord: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `Alright! I will start. My word is... ${context.currentWord}`,
        }),
        onDone: { target: "listenWord" },
        onError: { target: "listenWord" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 6 : listen for the player's word
    // 2. listen once
    // 3. then go and work out what they meant
    // 4. stash the raw utterance in memory first
    // 5. listen again if any hiccup happens

    listenWord: {
      invoke: {
        src: "fhListen",
        onDone: {
          target: "processWord",
          actions: assign(({ event }) => ({ lastResult: event.output })),
        },
        onError: { target: "listenWord" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7 : work out what the utterance meant
    //
    // "always" transitions fire immediately and this state says nothing : it
    // only routes. The order of the guards is the whole logic, because the
    // phrases overlap: "what does it mean" contains "what", and "what" alone
    // means "say that again".
    //
    // 2. the list, checked top to bottom
    // 3. they do not know our word : explain it. 1st, because these phrases contain "what" and would otherwise be caught below
    // 4. they asked why : justify it. Before word handling, so "why did you pick that?" is never mistaken for someone playing the word "why"
    // 5. they did not hear us : just repeat the word. After wantsWhy, so that "what do you mean?" still gets the explanation
    // 6. nothing usable, or only a fragment like "fl"? ask again
    // 7. a word we have already played? tease them
    // 8. otherwise a valid new word: remember it and go and judge it
    // 9. clean it once
    // 10. store it as the word we are about to judge
    // 11. NOTE: it is deliberately not added to history here : it only joins the chain once accepted, so a rejected word is not counted as "already used" and they are free to try it again later
    processWord: {
      always: [
        { guard: ({ context }) => wantsDefinition(context.lastResult), target: "defineWord" },
        { guard: ({ context }) => wantsWhy(context.lastResult), target: "explainMotivation" },
        { guard: ({ context }) => wantsRepeat(context.lastResult), target: "sayAgain" },
        {
          guard: ({ context }) => !isPlayableWord(cleanWord(context.lastResult)),
          target: "didNotCatch",
        },
        {
          guard: ({ context }) => context.history.includes(cleanWord(context.lastResult)),
          target: "alreadyUsed",
        },
        {
          target: "checkRelated",
          actions: assign(({ context }) => {
            const word = cleanWord(context.lastResult);
            return {
              pendingUserWord: word,
            };
          }),
        },
      ],
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7a-1 : they do not know our word, so say what it means No point is at stake here : not knowing a word is not a mistake
    // 2. the define actor both fetches and speaks, then back to the clock

    defineWord: {
      invoke: {
        src: "define",
        input: ({ context }) => ({ word: context.currentWord }),
        onDone: { target: "checkClock" },
        onError: { target: "checkClock" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7a0 : they did not hear us, so just say the word again. No explanation, nothing at stake : the shortest possible repair
    // 2. said twice to solidify, because a single word is exactly what was hard to catch the first time

    sayAgain: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `My word is ${context.currentWord}. ${context.currentWord}.`,
        }),
        onDone: { target: "checkClock" },
        onError: { target: "checkClock" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7a : we heard something, but no usable word in it
    // 2. kept short on purpose: this fires in case repeated silence occurs

    didNotCatch: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `My word is ${context.currentWord}.`,
        }),
        onDone: { target: "checkClock" },
        onError: { target: "checkClock" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7b : that word has been played already
    // 2. name the repeat and ask for another

    alreadyUsed: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `We already had ${cleanWord(context.lastResult)}! Give me another one.`,
        }),
        onDone: { target: "checkClock" },
        onError: { target: "checkClock" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7c : is the player's word actually related?
    // (big state)
    // Measured with embeddings rather than by asking the model: 
    // it is fast, and it produces a number we can log and tune. 
    // Below the threshold Furhat questions the word instead of
    // simply following it : which is what stops the game being steered
    // anywhere the player likes. Otherwise player could say anything and Furhat would accept.
    //
    // 2. run the scoring job with the two words
    // 7. first low score this turn: assume the robot misheard, not that they are
    // wrong. Recognizers mangle single words often enough that suspecting
    // ASR first is both more accurate and more polite. In addition the following question: "Did you say X" prompts
    // for either yes or no or a proper sentence which is easier to recognize.
    // 8. "!== null" matters: 0 is a real, very low score, and a plain truthiness test would wrongly read it as "no score at all"
    // 9. go and ask "did you say X?", and count the strike
    // 14. second low score: we have heard it twice now, so let's assume mishearing is unlikely : question the word itself
    // 15. go to the challenge
    // 19. related enough: play on as normal
    // 20. accept it
    // 24. the check itself failed : never block the game over that

    checkRelated: {
      invoke: {
        src: "judgeRelatedness",
        input: ({ context }) => ({
          userWord: context.pendingUserWord,
          ourWord: context.currentWord,
        }),
        onDone: [
          {
            guard: ({ event, context }) =>
              event.output !== null &&
              event.output < RELATEDNESS_THRESHOLD &&
              context.relatedAttempts === 0,
            target: "confirmWord",
            actions: assign(({ event, context }) => ({
              lastScore: event.output as number,
              relatedAttempts: context.relatedAttempts + 1,
            })),
          },
          {
            guard: ({ event }) =>
              event.output !== null && event.output < RELATEDNESS_THRESHOLD,
            target: "challengeUser",
            actions: assign(({ event }) => ({ lastScore: event.output as number })),
          },
          {
            target: "acceptWord",
            actions: assign(({ event }) => ({
              lastScore: (event.output as number | null) ?? 0,
            })),
          },
        ],
        onError: { target: "acceptWord" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7d : "Did you say X?"
    //
    // Before questioning the player we question the robot's ASR. Only if they
    // confirm the word do we go on to doubt whether it is related.
    //
    // 2. count the strike here, so a corrected word that is still low goes straight to the challenge instead of looping round again
    // 3. ask the question, then listen for the answer

    confirmWord: {
      entry: assign(({ context }) => ({
        relatedAttempts: context.relatedAttempts + 1,
      })),
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `Did you say ${context.pendingUserWord}?`,
        }),
        onDone: { target: "listenConfirm" },
        onError: { target: "listenConfirm" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7d-3 : their answer to "did you say X?"
    //
    // The guard order : is the whole logic here. A plain "yes" is three letters
    // and would otherwise pass as a corrected word : which is exactly the bug
    // that made Furhat once score "classroom -> yes" at 0.4 on a test run.
    //
    // 2. listen
    // 3. 1st: an explicit repair, "I said cake". This wins even when the sentence also contains "yes", because "yes, I said cake" is a
    // correction with a yes attached, not an agreement
    // 4. swap the new word in and judge that instead
    // 12. "yes, that is what I said": the word stands, so now we question
    // whether it is related, which is a different question
    // 13. go to the challenge
    // 17. "no", with no replacement word: ask them to say it again
    // 18. go to askAgain
    // 21. a bare word with no marker, "cake" on its own. Checked after yes/no,
    // so a plain "yes" can never be mistaken for a new word
    // 22. swap it in and judge it
    // 31. anything else: ask the question again

    listenConfirm: {
      invoke: {
        src: "fhListen",
        onDone: [
          {
            guard: ({ event, context }) => {
              const word = cleanWord(event.output);
              return hasRepairMarker(event.output) &&
                     isPlayableWord(word) &&
                     word !== context.pendingUserWord;
            },
            target: "checkRelated",
            actions: assign(({ event }) => ({
              pendingUserWord: cleanWord(event.output),
            })),
          },
          {
            guard: ({ event }) => saysAgree(event.output) ||
                                  concedesToFurhat(event.output),
            target: "challengeUser",
          },
          {
            guard: ({ event }) => saysDisagree(event.output),
            target: "askAgain",
          },
          {
            guard: ({ event, context }) => {
              const word = cleanWord(event.output);
              return !isJustAnAnswer(event.output) &&
                     looksLikeCorrection(event.output) &&
                     isPlayableWord(word) &&
                     word !== context.pendingUserWord;
            },
            target: "checkRelated",
            actions: assign(({ event }) => ({
              pendingUserWord: cleanWord(event.output),
            })),
          },
          { target: "confirmReprompt" },
        ],
        onError: { target: "confirmReprompt" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7d-4 : could not tell what they meant, so re-ask
    // 2. a shorter, plainer version of the same question

    confirmReprompt: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `Sorry, was your word ${context.pendingUserWord}?`,
        }),
        onDone: { target: "listenConfirm" },
        onError: { target: "listenConfirm" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7d-5 : they said no but gave no word
    // Back to ordinary listening: whatever they say next is treated as a fresh word and goes through processWord as usual
    // 2. ask, then listen

    askAgain: {
      invoke: {
        src: "fhSpeak",
        input: { text: "What was your word?" },
        onDone: { target: "listenWord" },
        onError: { target: "listenWord" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7e : strike two, question the word itself
    //
    // We have heard the same distant word twice now, so this is probably not
    // a recognition slip. Rather than silently rejecting it : any automatic
    // checker misjudges sometimes : Furhat puts it to the player. They have
    // the final say, backing down costs them a point.
    //
    // 2. ask, then listen for the verdict

    challengeUser: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text:
            `I don't think ${context.pendingUserWord} and ${context.currentWord} ` +
            `are related. Are you sure about your answer?`,
        }),
        onDone: { target: "listenVerdict" },
        onError: { target: "listenVerdict" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7e-2 : hear their verdict
    //
    // We do not store the answer in lastResult : that still holds the word
    // being judged. The reply reaches the transcript through listen() itself.
    //
    // 2. listen
    // 3. checked top to bottom, first matching guard wins
    // 4. "yeah, you're right" = agreeing with robot's doubt, conceding.
    // Checked 1st because it usually contains a "yeah" that the
    // agreement rule below would otherwise read as "I'm sure"
    // 5. Furhat scores
    // 8. "no yeah" and friends: we cannot tell, and a point is at stake, so ask again rather than guess
    // 9. re-ask
    // 12. "no, I'm not sure": they back down, so Furhat scores
    // 16. "yes, I'm sure" or "they are related": the word is accepted
    // 20. not a verdict at all, but clearly a repair? then we misheard the word : swap it in and judge it again
    // 32. anything else: ask for the verdict again

    listenVerdict: {
      invoke: {
        src: "fhListen",
        onDone: [
          {
            guard: ({ event }) => concedesToFurhat(event.output),
            target: "furhatScores",
          },
          {
            guard: ({ event }) => isAmbiguousVerdict(event.output),
            target: "verdictReprompt",
          },
          {
            guard: ({ event }) => saysDisagree(event.output),
            target: "furhatScores",
          },
          {
            guard: ({ event }) => saysAgree(event.output),
            target: "sureAccepted",
          },
          {
            guard: ({ event, context }) => {
              const word = cleanWord(event.output);
              return looksLikeCorrection(event.output) &&
                     isPlayableWord(word) &&
                     word !== context.pendingUserWord;
            },
            target: "checkRelated",
            actions: assign(({ event }) => ({
              pendingUserWord: cleanWord(event.output),
            })),
          },
          { target: "verdictReprompt" },
        ],
        onError: { target: "verdictReprompt" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7f : verdict unclear, so re-ask
    // 2. the same question, more plainly

    verdictReprompt: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `Are you sure ${context.pendingUserWord} ` +
                `is related to ${context.currentWord}?`,
        }),
        onDone: { target: "listenVerdict" },
        onError: { target: "listenVerdict" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7g : they stood by their word, so accept it
    // 2. say so, then let it join the chain
    sureAccepted: {
      invoke: {
        src: "fhSpeak",
        input: { text: "Okay, let's continue." },
        onDone: { target: "acceptWord" },
        onError: { target: "acceptWord" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7i : they backed down, so Furhat scores
    //
    // The word is rejected, so it never joins the chain and currentWord stays
    // where it was : the player simply tries again from the same word. This
    // is what actually stops the game being steered off topic.
    //
    // 2. award the point and reset the strike counter for the next turn
    // 5. say so

    furhatScores: {
      entry: assign(({ context }) => ({
        furhatScore: context.furhatScore + 1,
        relatedAttempts: 0,
      })),
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `Then that's a point for me. My word is still ${context.currentWord}.`,
        }),
        onDone: { target: "checkClock" },
        onError: { target: "checkClock" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 7h : the word is accepted and joins the chain
    //
    // This is the one place a player's word enters history, whether it sailed through the check or survived a challenge.
    //
    // 2. add it to the chain
    // 4. ...count the round
    // 5. ...and clear the strike counter, because this turn is resolved
    // 6. [...old, new] builds a new list; XState memory is never edited in place, always replaced
    // 10. nothing to say here, so go straight on to the model

    acceptWord: {
      entry: [
        assign(({ context }) => ({
        history: [...context.history, context.pendingUserWord],
        rounds: context.rounds + 1,
        relatedAttempts: 0,
        })),
      ],
      always: { target: "think" },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 8 : ask the model for our next word
    // 2. run the thinking job, passing it everything it needs
    // 9. checked top to bottom
    // 10. the model produced nothing usable after three tries
    // 11. otherwise store the reply and go and speak it
    // 12. the actor hands back both the answer and its score
    // 17. keep the reply for the respond state
    // 18. this is our word now
    // 19. store why we chose it, so "why?" can be answered instantly later with no second call to the model
    // 22. extend the chain
    // 27. the tunnel died mid game

    think: {
      invoke: {
        src: "think",
        input: ({ context }) => ({
          userWord: context.pendingUserWord,
          currentWord: context.currentWord,
          history: context.history,
        }),
        onDone: [
          { guard: ({ event }) => event.output?.reply?.word == null, target: "outOfWords" },
          {
            target: "respond",
            actions: assign(({ context, event }) => {
              const reply = event.output.reply as LlmReply;
              const word = reply.word as string;
              return {
                nextReply: reply,
                currentWord: word,
                currentMotivation:
                  reply.motivation ?? "it just felt connected",
                history: [...context.history, word],
              };
            }),
          },
        ],
        onError: { target: "llmUnavailable" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 9 : speak our answer
    //
    // Furhat says the word and nothing else : no quip, no "that makes me
    // think of". 
    // This is where the empirical finding is. One card is dealt from the
    // gaze deck, and it decides when the eyes come back relative to the voice.
    //
    // 2. deal one card
    // 3. a positive card: speak now, eyes follow
    // 4. set a timer for that many milliseconds, then look back
    // 8. a negative card: eyes first, voice follows
    // 9. bring the gaze back immediately, and let the speaking actor wait out the remainder
    // 13. remember the card, because the speaking actor needs it
    // 16. speak, using the actor that can wait first
    // 17. just the word, on its own
    // 19. a negative card means the eyes arrived first, so hold the speech back by that much and the measured gap is reproduced
    // 22. then check the clock

    respond: {
      entry: assign(() => {
        const delay = drawLookBackMs();
        if (delay >= 0) {
          setTimeout(() => {
            furhat.attendUser();
            console.log(`GAZE: back to the player ${delay} ms after speaking`);
          }, delay);
        } else {
          furhat.attendUser();
          console.log(`GAZE: back to the player ${-delay} ms before speaking`);
        }
        return { lookBackMs: delay };
      }),
      invoke: {
        src: "fhSpeakAfter",
        input: ({ context }) => ({
          text: context.currentWord,
          waitMs: context.lookBackMs < 0 ? -context.lookBackMs : 0,
        }),
        onDone: { target: "checkClock" },
        onError: { target: "checkClock" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 9a : has the five minutes run out?
    // Routing only, no speaking
    // 2. time is up -> wrap up; otherwise -> back to listening
    
    checkClock: {
      always: [
        { guard: ({ context }) => timeIsUp(context), target: "gameOver" },
        { target: "listenWord" },
      ],
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 9b : they asked "why?", so justify our word
    //
    // No call to the model is needed : we saved the reason when we picked the
    // word. Speaking it puts it on trial, and they get to judge it.
    //
    // 2. reason itself + question

    explainMotivation: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `${asSentence(context.currentMotivation)} Do you think that's valid?`,
        }),
        onDone: { target: "listenChallenge" },
        onError: { target: "listenChallenge" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 9c : hear their verdict on our reasoning
    // 2. listen, then check the guards top to bottom
    // 4. "you're right" / "fair enough" here means they accept our reason, so
    // no point is awarded and play simply resumes
    // 8. too ambiguous to award a point on
    // 12. rejection: the player wins the point
    // 17. acceptance: back to the game
    // 21. anything unclear: ask again

    listenChallenge: {
      invoke: {
        src: "fhListen",
        onDone: [
          {
            guard: ({ event }) => concedesToFurhat(event.output),
            target: "repeatWord",
          },
          {
            guard: ({ event }) => isAmbiguousVerdict(event.output),
            target: "challengeReprompt",
          },
          {
            guard: ({ event }) => saysDisagree(event.output),
            target: "userScores",
          },
          {
            guard: ({ event }) => saysAgree(event.output),
            target: "repeatWord",
          },
          { target: "challengeReprompt" },
        ],
        onError: { target: "challengeReprompt" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 9d : verdict unclear, so re-ask
    // a plainer version of the question

    challengeReprompt: {
      invoke: {
        src: "fhSpeak",
        input: { text: "Do you agree with my motivation?" },
        onDone: { target: "listenChallenge" },
        onError: { target: "listenChallenge" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 9e : our reasoning was accepted, so resume
    // 2. remind them of the word and hand the turn back

    repeatWord: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `Okay! Now it's your turn again. I just said ${context.currentWord}.`,
        }),
        onDone: { target: "checkClock" },
        onError: { target: "checkClock" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 9f : our reasoning was rejected, so the player scores
    //
    // The greeting promises "if you don't accept my explanation, you get a
    // point" : this is where that happens.
    //
    // 2. award the point
    // 3. say so, and note that our word has not changed

    userScores: {
      entry: assign(({ context }) => ({ userScore: context.userScore + 1 })),
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: `Fair enough, you get a point. My word is still ${context.currentWord}.`,
        }),
        onDone: { target: "checkClock" },
        onError: { target: "checkClock" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 9g : the model is unreachable, so stop
    //
    //
    // 2. a note for whoever is watching the terminal
    // 5. tell the human

    llmUnavailable: {
      entry: () => {
        console.error("LLM unavailable. See the startup check above for why.");
      },
      invoke: {
        src: "fhSpeak",
        input: {
          text:
            "Sorry, my brain isn't working right now, " +
            "Please wait and my human will fix me!",
        },
        onDone: { target: "done" },
        onError: { target: "done" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 10 : we ran out of words, so the player wins
    // outdated but can stay just in case

    outOfWords: {
      invoke: {
        src: "fhSpeak",
        input: { text: "You got me, I can't think of anything! You win!" },
        onDone: { target: "done" },
        onError: { target: "done" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 11 : the clock ran out, so announce the score and finish
    // 2. work out the closing line from the two scores; the ? : chain is a compact if / else if / else
    // 6. say it

    gameOver: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => {
          const who =
            context.userScore > context.furhatScore ? "You win!"
            : context.furhatScore > context.userScore ? "I win this time!"
            : "It's a draw!";
          return {
            text: `Time's up. That's five minutes! Final score: ` +
                  `you ${context.userScore}, me ${context.furhatScore}. ` +
                  `${who} Thanks for playing!`,
          };
        },
        onDone: { target: "done" },
        onError: { target: "done" },
      },
    },

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. STATE 12 : the final state, where the machine stops
    // 2. "final" means nothing happens after this
    // 3. say so
    // 5. write how this session's gaze timing compared with the measured
    // data : sessionSummary() gives back several lines, and logTurn puts
    // each one in the transcript file as well as the terminal
    // 6. say where the transcript was saved
    // 7. end the Node program cleanly (0 means "finished normally")
    done: {
      type: "final",
      entry: () => {
        console.log("Game over.");
        for (const line of sessionSummary()) logTurn("SYSTEM", line);
        console.log("Transcript saved to:", transcriptPath);
        process.exit(0);
      },
    },
  },
});

////////////////////////////////////////////////////////////////////////////////////////////////////////


///////////////////////////////////////// STARTING EVERYTHING //////////////////////////////////////////


    // main() wraps the startup so we can await the checks before the robot
    // says anything. Without it, a missing model would only reveal itself
    // mid game, after the greeting had already been delivered.
    //
    // The order is deliberate: the robot first, because an unreachable robot
    // is the commonest problem and the least obvious from the errors it
    // causes later on.
    //
    // 1.  the function
    // 2.  a visual divider, sixty "=" characters
    // 3.  say we are starting
    // 4.  is the robot there?
    // 6.  if not:
    // 7.  ...say so
    // 8.  ...and stop (1 means "finished with an error")
    // 10. is the model installed? This prints the name, the address, and
    // exactly what to fix if something is wrong
    // 12. this game is LLM only: without a model there is nothing to play
    // 13. ...so stop here rather than greeting the player and failing later
    // 16. check the EMBEDDING model too. Unlike the chat model this one is
    // optional: if it is missing we say so and play on without
    // relatedness filtering, rather than refusing to start
    // 18. fire the warm-up but do not await it : the model loads into memory
    // while Furhat is delivering its 30 second greeting, so the first
    // real turn is fast
    // 19. build this participant's gaze deck and log it
    // 20. bring the machine to life
    // 21. print every state change
    // START!

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("WordGame starting");
  const robotOk = await realFurhat.checkConnection();
  console.log("=".repeat(60));
  if (!robotOk) {
    console.error("Aborting: cannot reach the robot. Fix the above and try again.");
    process.exit(1);
  }
  const modelOk = await checkModel();
  console.log("=".repeat(60));
  if (!modelOk) {
    console.error("Aborting: no usable LLM. Fix the above and try again.");
    process.exit(1);
  }
  await checkEmbeddingModel();
  console.log("=".repeat(60));
  warmUp();
  startSession();
  const actor = createActor(gameMachine);
  actor.subscribe((state) => {
    console.log("STATE:", state.value);
  });
  actor.start();
}

////////////////////////////////////////////////////////////////////////////////////////////////////////


    // 1. run it. .catch prints any unexpected startup error instead of
    // letting Node dump a raw stack trace
main().catch((error) => console.error("Fatal startup error:", error));
