// embeddings.ts - this module is to make vectors from answers of the participants and the furhat and compare with cosine similarity
//    if they are not related: challenge the participant


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. where Ollama listens; ??: "use the environment variable, or this default if it's missing"
// 2. the same address with "/api/chat" cut off the end, so "/api/embeddings" can be attached instead with regex
// 3. which embedding model to use for vectors of answers in the game
// 4. the cut-off score; Number() is needed because environment variables are always text; and adjust the threshold accordingly 0.45 feels accurate

const OLLAMA_API_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/chat";
const OLLAMA_BASE_URL = OLLAMA_API_URL.replace(/\/api\/chat\/?$/, "");
export const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
export const RELATEDNESS_THRESHOLD = Number(process.env.RELATEDNESS_THRESHOLD ?? 0.45);


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. a dictionary from a word to its vector; Map<key type, value type>
// 2. asks the server for one word's vector; async because it waits on the network
// 3. have we fetched this word before?
// 4. if so, hand back the stored copy;  asking again is wasted time
// 5. try/catch: if anything inside throws an error, jump to the catch at the bottom instead of crashing
// 6. send a request and wait for the reply
// 7. POST means "I am sending data", not just asking for a page
// 8. tell the server the data is JSON
// 9. the data itself, turned from an object into text by JSON.stringify
// 10. which model should make the vector
// 11. the word to turn into a vector
// 12. if block: did the server answer with an error code? (! means "not")
// 13. log which error code it was
// 14. give back null rather than crashing
// 15. read the reply and turn the text back into a json object
// 16. pull out the embedding field; it might be missing, so "| undefined"
// 17. is it actually a list, and not empty? a bad reply could give text or nothing
// 18. say so if that is the case
// 19. give back null again
// 20. remember it, so the next request for this same word costs nothing
// 21. hand the vector back
// 22. we only reach here if something above threw; a dead ssh tunnel, usually
// 23. report it
// 24. give back null; so the caller decides what to do: we will continue without checking it if that happens

const cache = new Map<string, number[]>();
async function getEmbedding(word: string): Promise<number[] | null> {
  const cached = cache.get(word);
  if (cached) return cached;
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",                                   
      headers: { "Content-Type": "application/json" },  
      body: JSON.stringify({
        model: EMBED_MODEL,   
        prompt: word,         
      }),
    });
    if (!response.ok) {                                 
      console.error(`Server returned this for embeddings: ${response.status}`);
      return null;
    }
    const data = await response.json();                 
    const vector: number[] | undefined = data.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      console.error("Embeddings: reply had no vector");
      return null;
    }
    cache.set(word, vector);                            
    return vector;
  } catch (error) {
    console.error("Embeddings: cannot reach Ollama:", error);
    return null;
  }
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// Cosine similarity between two vectors:
// (a . b) / (|a| * |b|)
// below block does it in typescript language for a and b numbers


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1.  a function other files can call; takes two lists of numbers (which are our vectors), gives back one number
// 2.  a running total for the dot product, starting at 0 (let variable because it will change, obviously)
// 3.  a running total for vector a's length, will be squared
// 4.  a running total for vector b's length, will be squared
// 5.  walk through both vectors together, one position at a time; for loop: (start at 0, while i is below the length, add 1)
// 6.  multiply the two numbers at this position and add the result to dot (+= means "add to")
// 7.  multiply a's number by itself (square it) and add it to magA
// 8.  the same for b
// 9.  closes the loop; so goes back to line 5 with i one higher, until every position is done
// 10. Math.sqrt undoes the squaring with rooting, turning each total into a real length; then multiply the two lengths
// 11. if either vector was all zeros the lengths are 0, and dividing by 0 breaks; then so give 0 and stop
// 12. divide: this cancels out how "long" the vectors are, leaving only how much they point the same way

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;        
  let magA = 0;       
  let magB = 0;       
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];   
    magA += a[i] * a[i];  
    magB += b[i] * b[i];  
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  if (denominator === 0) return 0;   
  return dot / denominator;          
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1. a function other files can call; takes two words, gives back a score OR null (async because it waits on the server; Promise<...> is the type of "an answer that arrives later")
// 2. ask for "both" vectors at once, wait for both, and unpack the two results into vecA and vecB
// 3. the first request
// 4. the second request
// 5. we close the list of requests
// 6. if either came back null (! means "not"), there is nothing to compare; give back null and let caller decide, we will continue without cheching if this case happens
// 7. otherwise work out the score from the previous block and hand it back


export async function relatedness(wordA: string, wordB: string): Promise<number | null> {
  const [vecA, vecB] = await Promise.all([
    getEmbedding(wordA),
    getEmbedding(wordB),
  ]);
  if (!vecA || !vecB) return null;              
  return cosineSimilarity(vecA, vecB);          
}


////////////////////////////////////////////////////////////////////////////////////////////////////////


// 1.  another function other files can call so we export; runs once at startup, gives back true or false
// 2.  score a test pair and wait for the answer; this is purely to see whether the whole path works
// 3.  did it fail? (=== null checks for "no answer", which is different from a real score of 0)
// 4.  say so in red in the terminal (console.error rather than console.log)
// 5.  give back false; then main.ts carries on anyway, just without relatedness filtering
// 6.  it worked: print the model name, the test score to 3 decimals (toFixed(3)), and the current threshold
// 7.  give back true

export async function checkEmbeddingModel(): Promise<boolean> {
  const score = await relatedness("apple", "banana"); 
  if (score === null) {
    console.error(`Error for embeddings startup!!`);
    return false;
  }
  console.log(`Embedding moodel "${EMBED_MODEL}" is ready (test: apple/banana = ${score.toFixed(3)}, threshold = ${RELATEDNESS_THRESHOLD})`);;
  return true;
}