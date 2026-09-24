// gazedeck.ts - this module is to decide how long Furhat waits before looking back at the player.
//
//    value = (gaze turns towards) - (speech onset)
//
//    POSITIVE = they spoke first, the eyes followed
//    NEGATIVE = the eyes arrived first, then they spoke


////////////////////////////////////////////////////////////////////////////////////////////////////////


// every measured delay, in milliseconds, sorted smallest to largest. read only
// check onsets.csv, measured data from pilots human vs human on ELAN
const MEASURED_DELAYS: readonly number[] = [
   -615,  -534,  -400,  -242,  -207,  -200,  -200,  -200,  -167,  -167,
   -134,  -100,  -100,  -100,   -67,   -67,   -66,   -66,   -66,   -34,
    -34,   -33,   -33,   -33,     0,     0,     0,     0,    26,    33,
     33,    33,    33,    33,    34,    34,    66,    66,    67,    67,
     73,    79,    96,   100,   100,   100,   100,   133,   133,   133,
    133,   133,   133,   134,   134,   156,   159,   166,   166,   167,
    167,   167,   167,   200,   200,   200,   223,   233,   233,   233,
    234,   234,   234,   266,   266,   267,   269,   285,   300,   300,
    333,   335,   366,   366,   367,   400,   400,   412,   433,   454,
    467,   473,   500,   528,   533,   533,   542,   588,   600,   633,
    633,   666,   667,   700,   733,   739,   800,   800,   821,   833,
    867,   900,   900,   933,   956,   967,   967,  1012,  1066,  1093,
   1133,  1151,  1156,  1170,  1200,  1200,  1233,  1234,  1333,  1467,
   1567,  1596,  1666,  1669,  1700,  1733,  1958,  2433,  2500,
];


////////////////////////////////////////////////////////////////////////////////////////////////////////


// how many cards a fresh deck holds.
// a 5 minute game would usually be around 12 turns each player.
const DECK_SIZE = 12;


////////////////////////////////////////////////////////////////////////////////////////////////////////


// when the deck runs out mid-game we do not deal a whole new one. That
// would be twelve cards for perhaps four remaining turns. A smaller top-up
// keeps the proportions while wasting less of the distribution.
const TOPUP_SIZE = 6;


////////////////////////////////////////////////////////////////////////////////////////////////////////


// the cards waiting to be dealt. Starts empty, then buildDeck() fills it.
let deck: number[] = [];


////////////////////////////////////////////////////////////////////////////////////////////////////////


// everything dealt so far this session, so the end of game summary can report what the player actually experienced.
let dealt: number[] = [];


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. a function that takes a number (how many cards in the deck), gives back a list of numbers
// 2. start with an empty list to collect the cards in
// 3. if size = 12, i counts 0, 1, 2 ... 11 --- for (start at 0, keep going while i is below size, add 1 each time)
// 4. where this slice begins: i x 139 / 12, rounded Down because list positions must be whole numbers
// 5. where it ends: the same sum with the NEXT slice number (i+1), so slice 3 runs 34 to 45
// 6. ...and Math.max(start + 1, ...) forces the slice to be at least 1 wide, in case size is bigger than the data
// 7. pick a random position INSIDE the slice: start + a random amount less than the slice width
// 8. look up the value at that position and add it to the deck
// 9. closes the loop -- go back to line 3 with i one higher, until all 12 slices are done
// 10. the cards were built low-to-high, so shuffle them into random order and hand them back

function buildDeck(size: number): number[] {
  const cards: number[] = [];
  for (let i = 0; i < size; i++) {
    const start = Math.floor((i * MEASURED_DELAYS.length) / size);
    const end = Math.max(start + 1,
                         Math.floor(((i + 1) * MEASURED_DELAYS.length) / size));
    const pick = start + Math.floor(Math.random() * (end - start));
    cards.push(MEASURED_DELAYS[pick]);
  }
  return shuffle(cards);
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. a function that takes a list of numbers and gives back the SAME list, reordered
// 2. walk BACKWARDS from the last position to position 1 --- for (start at the end, keep going while i is above 0, subtract 1 each time)
// 3. pick a random position j that is anywhere from 0 up to and including i
// 4. swap the two items: what was at i goes to j, what was at j goes to i
// 5. closes the loop -- go back to line 2 with i one lower, until i reaches 0
// 6. hand the reordered list back

function shuffle(items: number[]): number[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));   // a slot at or before i
    [items[i], items[j]] = [items[j], items[i]];     // swap the two
  }
  return items;
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1.  a function other files can call; takes nothing, gives nothing back (void)
// 2.  build a fresh 12-card deck and store it in the shared "deck" variable, replacing whatever was there
// 3.  empty the record of dealt cards, so this session's summary starts from nothing
// 4.  print a line of 60 "=" characters as a visual divider in the terminal
// 5.  announce how many cards this session has ("Wed" -- the backticks let ${DECK_SIZE} be inserted)
// 6.  print the deck in the order it will be dealt; join(", ") turns the list into one string
// 7.  make a SORTED COPY -- [...deck] copies first, because .sort() would otherwise reorder the real deck
// 8.  print that sorted copy, which makes the spread of values easy to read
// 9.  print the median of this deck...
// 10. ...and how many of its cards are negative (eyes-first); .filter() keeps only items passing the test
// 11. print the same two figures for the full measured data, so the two can be compared at a glance

export function startSession(): void {
  deck = buildDeck(DECK_SIZE);
  dealt = [];
  console.log("=".repeat(60));
  console.log(`GAZE DECK: ${DECK_SIZE} cards for this session (ms, in deal order)`);
  console.log("  " + deck.join(", "));
  const sorted = [...deck].sort((a, b) => a - b);
  console.log(`  sorted: ${sorted.join(", ")}`);
  console.log(`  median ${median(sorted)} ms, ` +
              `${sorted.filter((v) => v < 0).length} of ${sorted.length} eyes-first`);
  console.log(`  (measured data: median 233 ms, 24 of 139 eyes-first)`);
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. a function other files can call; takes nothing, gives back one number (the delay in ms)
// 2. is the deck empty? (=== is strict equality: checks the value AND the type)
// 3. if so, build a small 6-card top-up the same way, so the proportions stay right
// 4. say so in the terminal, listing the new cards...
// 5. ...the + joins the two pieces into one message
// 6. closes the "if" -- if the deck still had cards, lines 3-5 were skipped entirely
// 7. take the LAST card off the deck; pop() removes AND returns it, so the card leaves the deck
// 8. record it in "dealt", so the end-of-session summary knows what the player experienced
// 9. hand the card back to the game

export function drawLookBackMs(): number {
  if (deck.length === 0) {
    deck = buildDeck(TOPUP_SIZE);
    console.log(`GAZE DECK: exhausted - topped up with ${TOPUP_SIZE} cards: ` +
                deck.join(", "));
  }
  const card = deck.pop() as number;
  dealt.push(card);
  return card;
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. takes an ALREADY-SORTED list, gives back its middle value
// 2. nothing to average if the list is empty, so give 0 and stop here
// 3. find the middle position: length divided by 2, rounded down
// 4. is the length odd or even? (% is remainder: 7 % 2 = 1 which counts as true, 8 % 2 = 0 which counts as false)
// 5. ODD  -> there is a single middle item, so return it
// 6. EVEN -> no single middle, so average the two either side of it and round
// 7. closes the function

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]                                   // odd: the middle one
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2); // even: average
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1.  a function other files can call; gives back a LIST of strings (string[]), one per line to print
// 2.  if nothing was dealt, return a single explanatory line and stop
// 3.  make a sorted COPY of the dealt cards ([...dealt] copies, so the real order is preserved)
// 4.  the mean: reduce() adds every item to a running total starting at 0, then divide by the count and round
// 5.  count how many cards were negative -- the turns where the eyes arrived before the voice
// 6.  start building the list of lines to return
// 7.  line one: how many cards were dealt
// 8.  line two: every card in the order it was dealt
// 9.  line three, part one: this session's median and mean...
// 10. ...part two: how many were eyes-first...
// 11. ...part three: that as a percentage
// 12. line four: the same figures for the measured corpus, so the two can be compared


export function sessionSummary(): string[] {
  if (dealt.length === 0) return ["GAZE DECK: no cards were dealt."];
  const sorted = [...dealt].sort((a, b) => a - b);
  const mean = Math.round(dealt.reduce((a, b) => a + b, 0) / dealt.length);
  const eyesFirst = dealt.filter((v) => v < 0).length;
  return [
    `GAZE DECK: ${dealt.length} cards dealt this session`,
    `  in order : ${dealt.join(", ")} ms`,
    `  median ${median(sorted)} ms   mean ${mean} ms   ` +
    `eyes-first ${eyesFirst}/${dealt.length} ` +
    `(${Math.round((100 * eyesFirst) / dealt.length)}%)`,
    `  measured : median 233 ms   mean 426 ms   eyes-first 24/139 (17%)`,
  ];
}
