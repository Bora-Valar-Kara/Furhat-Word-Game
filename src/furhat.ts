// furhat.ts - this module is everything that talks to the robot lives here, so no other file has to build a URL or know how the Remote API works.

// We can run it with the real robot or the virtual one without changing any code:

//      FURHATURI=192.168.1.11:54321 npx tsx src/main.ts     (real)
//      npx tsx src/main.ts                                  (virtual)


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. the robot's address; ?? means "use the environment variable, orS this default if it is missing": which is how the two commands above work
// 2. which voice to speak with, overridable the same way

const FURHATURI = process.env.FURHATURI ?? "localhost:54321";
export const VOICE_NAME = process.env.FURHAT_VOICE ?? "RyanNeural";


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. bring in logTurn, so every spoken line also goes into the transcript

import { logTurn } from "./transcript";


////////////////////////////////////////////////////////////////////////////////////////////////////////


///////////////////////////////////// GAZE SETTINGS ////////////////////////////////////////////////////
//                                                                                                    //
//    /furhat/attend?location=x,y,z points the robot's eyes at a spot in space                        //
//    the same thing the GAZE pad in the web interface does when you click it.                        //
//                                                                                                    //
//    The Remote API docs says x = left, y = FORWARD, z = up. Testing                                 //
//    on the robot showed that is wrong. The real order is                                            //    
//                                                                                                    //
//        x   side to side    negative = left,  positive = right                                      //
//        y   up and down     negative = down,  positive = up                                         //
//        z   forward         how far in front of the robot the target sits                           //
//                                                                                                    //      
////////////////////////////////////////////////////////////////////////////////////////////////////////


////////////////////////////////////////////////////////////////////////////////////////////////////////


// this next part is to prevent extreme gazes like 180 degrees right or left and minimal gaze directions like not even recognizable
// 1. how far in front of the robot the gaze target sits : an imaginary point in space that the robot aims its eyes
// 2. the smallest glance: a barely perceptible flicker
// 3. the largest glance: clear, but still polite (with the target 100 in front, these give roughly 4 to 17 degrees)
// 4. the direction of the previous glance, in radians; starts as null because there is no previous glance yet ("number | null" means either is allowed)
// 5. how different the next direction must be: 1.0 radian is about 57 degrees

const GAZE_FORWARD = 100;
const GAZE_MIN_RADIUS = 8;
const GAZE_MAX_RADIUS = 30;
let lastAngle: number | null = null;
const MIN_ANGLE_CHANGE = 1.0;


///////////////////////////////////// GAZE SETTINGS ////////////////////////////////////////////////////


// 1. how long the player gets to start answering, in milliseconds (10 seconds)
// 2. how many connection failures in a row before giving up on a turn
// 3. words the robot sends back instead of speech - "SILENCE" must never be played as a word, so these get filtered out

const ANSWER_WINDOW_MS = 10000;
const MAX_LISTEN_FAILURES = 3;
const STATUS_MESSAGES = ["SILENCE", "INTERRUPTED", "FAILED"];


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. a small helper that gives back the headers every request needs
// 2. start an empty collection of headers
// 3. add one: "please answer in JSON"
// 4. hand it back

function jsonHeaders(): Headers {
  const h = new Headers();
  h.append("accept", "application/json");
  return h;
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// the robot itself: an object holding every action, so other files can write furhat.say(...), furhat.listen() and so on

export const realFurhat = {


////////////////////////////////////////////////////////////////////////////////////////////////////////


  // 1. choose the voice; async because it waits for the robot to answer
  // 2. send the request (return hands back the reply, though nobody uses it)
  // 3. the address, with the voice name made safe for a URL
  // 4. POST because we are telling the robot to do something; body "" = no data

  async setVoice(name: string) {
    return fetch(
      `http://${FURHATURI}/furhat/voice?name=${encodeURIComponent(name)}`,
      { method: "POST", headers: jsonHeaders(), body: "" }
    );
  },


////////////////////////////////////////////////////////////////////////////////////////////////////////


  // 1.  say something out loud
  // 2.  record it in the transcript first, so it is logged even if the robot is unreachable
  // 3.  try: if anything inside fails, jump to the catch instead of crashing
  // 4.  send the request and WAIT for it...
  // 5.  blocking=true means the robot only replies once it has FINISHED speaking : that is what makes the whole game wait for each utterance
  // 6.  POST, with the standard headers and no body
  // 7.  closes the request
  // 8.  if it failed...
  // 9.  ...report the problem, but carry on : one failed sentence must not end the game
  // 10. closes the try/catch
  // 11. wait 200 ms before anything else happens
  // 12. closes the method

  async say(text: string) {
    logTurn("FURHAT", text);
    try {
      await fetch(
        `http://${FURHATURI}/furhat/say?text=${encodeURIComponent(text)}&blocking=true`,
        { method: "POST", headers: jsonHeaders(), body: "" }
      );
    } catch (error) {
      console.error("Error in Furhat say:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  },

  
////////////////////////////////////////////////////////////////////////////////////////////////////////  


  // 1. look at the player
  // 2. send the request and hand back the reply
  // 3. "whoever is nearest the robot"
  // 4. POST, standard headers, no body

  async attendUser() {
    return fetch(
      `http://${FURHATURI}/furhat/attend?user=CLOSEST`,
      { method: "POST", headers: jsonHeaders(), body: "" }
    );
  },


//////////////////////////////////////////////////////////////////////////////////////////////////////// 
  

  // 1. look at a POINT rather than a person : three numbers, in the order the robot really uses ; GAZE AWAY! : will be used by next block
  // 2. fetch
  // 3. the three numbers go into the address separated by commas
  // 4. POST, standard headers, no body

  async attendLocation(x: number, y: number, z: number) {
    return fetch(
      `http://${FURHATURI}/furhat/attend?location=${x},${y},${z}`,
      { method: "POST", headers: jsonHeaders(), body: "" }
    );
  },


////////////////////////////////////////////////////////////////////////////////////////////////////////


//////////////////////////////// MAIN GAZE AWAY BLOCK //////////////////////////////////////////////////


  // Break eye contact : glance at a random spot near the player's face.
  // Two random choices 
  //    1: a DIRECTION (an angle round a circle) and 
  //    2: a DISTANCE from the center turned into a point. 
  // Returns the point so the caller can log where the robot looked.

  // 1.  the method; it promises to give back an object with x, y and z
  // 2.  picks a random direction: Math.random() is 0 up to 1, and a full circle is 2 x pi radians, so this is anywhere round the circle
  // 3.  re-draw up to 20 times, but only if there was a ""previous glance""" : for (start at 0, while under 20 tries and lastAngle exists, add 1)
  // 4.  how far apart the new and old directions are...
  // 5.  ...taking the short way round: 350 degrees apart is really only 10
  // 6.  far enough apart? then stop re-drawing (break leaves the loop)
  // 7.  too close to last time: pick a fresh random direction and check again
  // 8.  close this loop
  // 9.  remember this direction, for comparing against next time
  // 10. pick a distance, evenly between the smallest and the largest glance
  // 12. the sideways part of the point: cos turns an angle into its left-right amount
  // 13. the up-and-down part: sin gives the vertical amount of the same angle
  // 14. the forward part is fixed
  // 15. put them in the order the robot really uses (see the note at the top)...
  // 16. ...y is vertical, despite what the documentation says
  // 17. ...z is forward
  // 18. try to send the glance...
  // 19. ...using attendLocation above ("this" means "this same robot object")
  // 20. if it failed...
  // 21. ...report it, but carry on executing a failed glance mustnt interrupt the game
  // 22. we close the try/catch
  // 23. hand back where the robot looked

  async lookAway(): Promise<{ x: number; y: number; z: number }> {
    let angle = Math.random() * 2 * Math.PI;
    for (let tries = 0; tries < 20 && lastAngle !== null; tries++) {
      let difference = Math.abs(angle - lastAngle);
      if (difference > Math.PI) difference = 2 * Math.PI - difference;
      if (difference >= MIN_ANGLE_CHANGE) break;
      angle = Math.random() * 2 * Math.PI;
    }
    lastAngle = angle;
    const radius =
      GAZE_MIN_RADIUS + Math.random() * (GAZE_MAX_RADIUS - GAZE_MIN_RADIUS);
    const sideways = Math.round(radius * Math.cos(angle));
    const vertical = Math.round(radius * Math.sin(angle));
    const forward = GAZE_FORWARD;
    const x = sideways;
    const y = vertical;
    const z = forward;
    try {
      await this.attendLocation(x, y, z);
    } catch (error) {
      console.error("Error in lookAway:", error);
    }
    return { x, y, z };
  },


////////////////////////////////////////////////////////////////////////////////////////////////////////


  // 1. to play a named facial gesture prebuilt in furhat web: currently not used by the game, could be deleted
  // 2. send the request and hand back the reply
  // 3. the gesture name, made safe for a URL
  // 4. POST, standard headers, no body

  async gesture(name: string) {
    return fetch(
      `http://${FURHATURI}/furhat/gesture?name=${encodeURIComponent(name)}`,
      { method: "POST", headers: jsonHeaders(), body: "" }
    );
  },

////////////////////////////////////////////////////////////////////////////////////////////////////////  


  // This section runs once at startup: to check if the robot is reachable, and does it have our voice?
  //
  // 1.  the method; gives back boolean
  // 2.  log which address we are about to try
  // 3.  try: if the connection fails, jump to the catch
  // 4.  ask for the list of voices : a dummy request that proves the robot answers ; also to check if Ryn voice is available
  // 5.  standard headers
  // 6.  give up after 5 seconds : fetch has no time limit of its own and could wait forever
  // 8.  did the robot answer with an error code?
  // 9.  say so
  // 10. and report failure
  // 12. read the reply, turning the text into a list of voice objects
  // 13. keep only each voice's name: ?? [] guards against a missing list, .map picks the name, .filter(Boolean) drops any empty ones
  // 14. report success
  // 15. if the robot has voices but not ours...
  // 16. ...say so...
  // 17. ...list the ones it does have...
  // 18. ...and where to change it
  // 20. report success
  // 21. we only get here if the connection itself failed
  // 22-26. print a checklist of the three usual causes
  // 27. report failure

  async checkConnection(): Promise<boolean> {
    console.log(`ROBOT: Remote API at http://${FURHATURI}`);
    try {
      const res = await fetch(`http://${FURHATURI}/furhat/voices`, {
        headers: jsonHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.error(`ROBOT: responded ${res.status}: is the Remote API skill running?`);
        return false;
      }
      const voices = await res.json();
      const names = (voices ?? []).map((v: any) => v.name).filter(Boolean);
      console.log(`ROBOT: Reachable`);
      if (names.length && !names.includes(VOICE_NAME)) {
        console.error(`ROBOT: voice "${VOICE_NAME}" is not installed.`);
        console.error(`ROBOT: available voices: ${names.join(", ")}`);
        console.error(`ROBOT: change VOICE_NAME in furhat.ts to one of these.`);
      }
      return true;
    } catch (error) {
      console.error(`ROBOT: cannot reach the Remote API at ${FURHATURI}.`);
      console.error("ROBOT: check that");
      console.error("  1. the robot is on and on the same network  (ping the address)");
      console.error("  2. the Remote API skill is running on the robot");
      console.error("  3. the address is right FURHATURI");
      return false;
    }
  },


////////////////////////////////////////////////////////////////////////////////////////////////////////


  // Only one listening attempt block. Solution to this:
  // The robot keeps listening for up to about 5 seconds, then gives up on its own; listen() below chains several of these together to give the player 10 seconds.
  //
  // 1.  the method; clearFirst defaults to true if not given
  // 2.  on the first attempt of a turn only...
  // 3.  ...stop any listening session left over from before, which otherwis can leave the robot deaf
  // 4.  POST
  // 5.  standard headers
  // 7.  closes the if (retries skip this, saving a round-trip)
  // 8.  say we are listening
  // 9.  start listening: this request stays open until the robot hears something, or its own 5 second silence window runs out
  // 10. GET, because we are asking for something back
  // 11. standard headers
  // 13. the reply arrives as a raw stream of bytes
  // 14. read the first chunk of it (! tells TypeScript "this is not missing")
  // 15. turn the bytes into text
  // 16. parse that text as JSON and pull out the "message" field
  // 18. nothing heard, or one of the status words? (.includes checks the list)
  // 19. give back an empty string, meaning "no speech"
  // 21. otherwise give back what was said

  async listenOnce(clearFirst: boolean = true): Promise<string> {
    if (clearFirst) {
      await fetch(`http://${FURHATURI}/furhat/listen/stop`, {
        method: "POST",
        headers: jsonHeaders(),
      });
    }
    console.log("(Re)Starting to listen.");
    const response = await fetch(`http://${FURHATURI}/furhat/listen`, {
      method: "GET",
      headers: jsonHeaders(),
    });
    const body = response.body;
    const chunk = await body!.getReader().read();
    const text = new TextDecoder().decode(chunk.value!);
    const message: string = JSON.parse(text).message;

    if (!message || STATUS_MESSAGES.includes(message.trim().toUpperCase())) {
      return "";
    }
    return message;
  },


////////////////////////////////////////////////////////////////////////////////////////////////////////


  // The full listen block: keeps attempting until someone speaks or 10 seconds pass.
  // The Remote API accepts no timeout of its own, so this is how the longer answer window is made.
  //
  // 1.  the method; gives back what was said, or "" for nothing
  // 2.  the moment the answer window closes: now plus 10 seconds
  // 3.  is this the first attempt of the turn? (decides whether to clear first if it is the first, call stop)
  // 4.  how many attempts in a row have failed
  // 6.  repeat forever : the "return" lines below are the only way out
  // 7.  what this attempt heard; empty until we know
  // 8.  try one attempt...
  // 9.  ...listen once, clearing first only if this is the first attempt
  // 10. now no longer the first
  // 11. it worked, so the failure count starts again from zero
  // 12. if the attempt threw an error (a connection problem)
  // 13. count it
  // 14. find a readable reason: ?. means "only if it exists", ?? gives a fallback
  // 15. report it, for example "Error in listen (2/3): ECONNREFUSED"
  // 16. three in a row?
  // 17. log what to check
  // 18. give up on this turn : the game treats "" as silence
  // 20. otherwise wait one second before trying again, rather than spinning flat out
  // 23. did someone speak?
  // 24. look back at the player (not awaited : no need to wait for the head to turn)
  // 25. record what they said in the transcript
  // 26. hand it to the game
  // 29. nothing yet : is the 10 seconds used up?
  // 30. record the silence
  // 31. give back "", which the game handles as "I didn't catch that"
  // 33. still time left: go round the loop and listen again. The player never notices the join between attempts : they simply get longer to think

  async listen(): Promise<string> {
    const deadline = Date.now() + ANSWER_WINDOW_MS;
    let first = true;
    let failures = 0;

    while (true) {
      let message = "";
      try {
        message = await this.listenOnce(first);
        first = false;
        failures = 0;
      } catch (error) {
        failures++;
        const cause = (error as any)?.cause?.code ?? (error as Error).message;
        console.error(`Error in listen (${failures}/${MAX_LISTEN_FAILURES}): ${cause}`);
        if (failures >= MAX_LISTEN_FAILURES) {
          console.error("ROBOT: is it on, and is the Remote API skill running?");
          return "";
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (message) {
        this.attendUser();
        logTurn("USER", message);
        return message;
      }

      if (Date.now() >= deadline) {
        logTurn("SYSTEM", "(no speech within 10 seconds)");
        return "";
      }
      // (line 33: nothing heard and time remains - loop round and listen again)
    }
  },

  // close the realFurhat object
};