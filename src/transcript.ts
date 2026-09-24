// transcript.ts - on this module everything the program prints goes to the terminal and to a text file, timestamped, so a whole session can be shared afterwards.
// captures: state changes, relatedness scores, gaze events, the startup checks, and errors.


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. Node's file tools (writing the transcript file)
// 2. Node's path tools (joining a folder and a file name safely)
// 3. Node's own formatter, the exact function console.log uses to turn its arguments (text, numbers, objects, errors) into one printed string

import * as fs from "node:fs";
import * as path from "node:path";
import { format } from "node:util";


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. the moment the program started every timestamp is measured from here
const sessionStart = new Date();


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. takes a number and a width, gives back text padded with leading zeros
// 2. String(num) turns 7 into "7"; padStart(2, "0") pads it to "07"

function zeroPad(num: number, width: number): string {
  return String(num).padStart(width, "0");
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. gives back a "[mm:ss.mmm]" stamp for right now, measured from the start
// 2. milliseconds since the program started (now minus the start time)
// 3. whole minutes: divide by 1000 to get seconds, by 60 for minutes, round down
// 4. leftover seconds: % 60 keeps only what is left over after whole minutes
// 5. leftover milliseconds: % 1000 keeps what is left over after whole seconds
// 6. glue them together in the [mm:ss.mmm] shape, padding each part with zeros

function stamp(): string {
  const ms = Date.now() - sessionStart.getTime();
  const minutes = Math.floor(ms / 1000 / 60);
  const seconds = Math.floor((ms / 1000) % 60);
  const millis = ms % 1000;
  return `[${zeroPad(minutes, 2)}:${zeroPad(seconds, 2)}.${zeroPad(millis, 3)}]`;
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. start the file name with "transcript-"
// 2. the start time as text, e.g. "2026-07-15T14:30:05.123Z"
// 3. keep only the first 19 characters: "2026-07-15T14:30:05"
// 4. swap the "T" for an underscore: "2026-07-15_14:30:05"
// 5. swap every ":" for "-" (colons are not good in file names)
// 6. add the ".txt" ending

const fileName =
  "transcript-" +
  sessionStart.toISOString()
    .slice(0, 19)
    .replace("T", "_")
    .replace(/:/g, "-") +
  ".txt";


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. the "transcripts" folder, next to wherever we ran the game from
// 2. create it if it is missing ("recursive" means: no error if it exists)
// 3. the full path to this session's file; "export" so main.ts can print it
// 4. write a header line

const folder = path.join(process.cwd(), "transcripts");
fs.mkdirSync(folder, { recursive: true });
export const transcriptPath = path.join(folder, fileName);
fs.appendFileSync(transcriptPath, `# WordGame transcript - ${sessionStart.toISOString()}\n`);


////////////////////////////////////////////////////////////////////////////////////////////////////////



// 1. keep the ORIGINAL console.log before replacing it; the new version must call the old one to actually print, or it would call itself forever
// 2. the same for console.error
// 3. the same for console.warn

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1.  takes the original printing function and whatever was passed to it
// 2.  turn the arguments into one string exactly as console.log would (format handles text, numbers, objects and errors the same way)
// 3.  take ONE timestamp for the whole call, so a multi-line message gets the same time on every line
// 4.  .split into lines, and stamp each one
// 5.  .but leave blank lines blank, so dividers and spacing still look right
// 6.  .put the lines back together
// 7.  print it to the terminal using the ORIGINAL function
// 8.  and append the same text to the transcript file

function capture(original: (...data: unknown[]) => void, args: unknown[]): void {
  const text = format(...args);
  const now = stamp();
  const stamped = text
    .split("\n")
    .map((line) => (line.length > 0 ? `${now} ${line}` : line))
    .join("\n");
  original(stamped);
  fs.appendFileSync(transcriptPath, stamped + "\n");
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. from now on, console.log means "capture, then print with the original" (...args collects every argument, however many were passed)
// 2. the same for console.error
// 3. the same for console.warn

console.log = (...args: unknown[]) => capture(originalLog, args);
console.error = (...args: unknown[]) => capture(originalError, args);
console.warn = (...args: unknown[]) => capture(originalWarn, args);


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. the function other files call to record who said what; the speaker can only be one of three words, so a typo is caught before the program runs
// 2. print "FURHAT: hello" - console.log is captured, so the timestamp and the file-writing now happen automatically; nothing more to do here

export function logTurn(speaker: "FURHAT" | "USER" | "SYSTEM", text: string): void {
  console.log(`${speaker}: ${text}`);
}