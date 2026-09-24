// types.ts - this module holds the shapes of the data, nothing else.
//    No behaviour lives here: these are descriptions that let TypeScript catch mistakes before the program is run.


////////////////////////////////////////////////////////////////////////////////////////////////////////


// One line of chat, in the form Ollama expects.
//
// 1. the shape; "export" so other files can use it
// 2. who is speaking; the | means "one of these three words only", so a typo like "systm" is caught by the compiler instead of confusing the model
// 3. what was said

export type Message = {
  role: "assistant" | "user" | "system";
  content: string;
};


////////////////////////////////////////////////////////////////////////////////////////////////////////


// The JSON object we ask the model to produce on every turn.
//
// 1. the shape
// 2. did the user's word plausibly relate to ours? Not spoken any more, but kept as a hook in case it becomes useful later
// 3. the model's next word, and the only thing Furhat actually says out loud. The ? marks it optional, because models sometimes leave it out: and the ? forces us to handle that case instead of crashing
// 4. why the model chose this word: one standalone sentence
// 5. generated together with the word, so answering "why?" later needs no second call to the model : we already have the reason
// 6. also optional, for the same reason as the word

export type LlmReply = {
  related: boolean;
  word?: string;
  motivation?: string;
};


////////////////////////////////////////////////////////////////////////////////////////////////////////


/////////////////////////////////// THE GAME'S MEMORY //////////////////////////////////////////////////
//                                                                                                    //
//    The context is our state machine's memory. Everything the game needs to                         //
//    remember between steps is in this one object, and the only way to                               //
//    change it is XState's assign()                                                                  //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1.  the shape; "interface" and "type" are near enough the same thing here
// 2.  the word Furhat said last
// 3.  why Furhat chose it, spoken and fires only when the player asks "why?"
// 4.  every word played so far, in order; string[] means "a list of strings"
// 5.  how many successful exchanges there have been
// 6.  the raw text of whatever the player just said, before any cleaning
// 7.  the reply we are about to speak; | null means it may be empty at first
// 8.  Date.now() at the moment play began, which the clock counts from
// 9.  the player's cleaned word for this turn. Kept separately from lastResult because a challenge makes them speak again, which would otherwise overwrite the very word we are in the middle of judging
// 12. the relatedness score of that word, kept for the logs
// 13. the gaze delay drawn for this answer: + means the eyes return after the voice starts, - means they return before it
// 15. how related Furhat's own answer was to the player's word; -1 when it was not measured (which is now always, since that behaviour was removed)
// 17. how many times this turn has scored below the threshold. 0 = first try,
// 18. so we assume we misheard and ask "did you say X?"; 1+ = we have heard it twice, so now we question the word itself
// 20. points the human/user/participant has earned
// 21. points Furhat has earned

export interface GameContext {
  currentWord: string;
  currentMotivation: string;
  history: string[];
  rounds: number;
  lastResult: string;
  nextReply: LlmReply | null;
  gameStartMs: number;
  pendingUserWord: string;
  lastScore: number;
  lookBackMs: number;
  ownScore: number;
  relatedAttempts: number;
  userScore: number;
  furhatScore: number;
}