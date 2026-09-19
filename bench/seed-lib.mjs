// Realistic-content generator + at-rest encryption helper for the benchmark
// seeder. encryptForTest() is a straight copy of
// /root/riffado-mcp/test/integration/seed.ts's helper (same v1:iv:tag:ct
// format the real app writes). Not imported from there because this file
// must stay a plain .mjs with no ts-node/build step.
import { createCipheriv, randomBytes } from "crypto"

export const TEST_ENCRYPTION_KEY = "11".repeat(32) // 64 hex chars, matches test fixtures

export function encryptForTest(plain, hexKey = TEST_ENCRYPTION_KEY) {
  const key = Buffer.from(hexKey, "hex")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`
}

export function encJson(value, hexKey = TEST_ENCRYPTION_KEY) {
  return JSON.stringify({ c: encryptForTest(JSON.stringify(value), hexKey) })
}

// Deterministic PRNG (mulberry32) so runs are reproducible but content still
// varies per recording index -- avoids the engine accidentally deduping /
// short-circuiting on identical strings across recordings.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)]
}

function shuffle(rng, arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Mixed German/English prose pool, deliberately loaded with umlauts, ß and
// accented loanwords so NFD normalization has genuine work to do.
const DE_SENTENCES = [
  "Wir haben heute über die Übergabe der Kita gesprochen und die nächsten Schritte festgelegt.",
  "Die Heizungsanlage läuft seit der Wartung wieder störungsfrei, der Druck liegt bei 1,8 bar.",
  "Nächste Woche müssen wir die Rückmeldung der Erzieherin einholen, bevor wir entscheiden.",
  "Es gab einige Missverständnisse bezüglich der Übergabezeiten, die wir klären sollten.",
  "Der Techniker empfiehlt, den Wärmetauscher im Frühjahr zu überprüfen.",
  "Frau Müller hat angemerkt, dass die Kommunikation zwischen den Abteilungen verbessert werden muss.",
  "Wir sollten die Öffnungszeiten für die Übergangsphase anpassen, damit niemand benachteiligt wird.",
  "Das Protokoll der letzten Besprechung enthält bereits die wichtigsten Beschlüsse.",
  "Herr Özdemir hat vorgeschlagen, ein zusätzliches Treffen im November einzuplanen.",
  "Die Rückmeldungen der Eltern waren überwiegend positiv, einige Fragen bleiben aber offen.",
  "Wir müssen die Kündigungsfristen noch einmal genau prüfen, bevor wir das Formular unterschreiben.",
  "Der Kühlschrank in der Küche wurde ausgetauscht, die Rechnung liegt dem Bericht bei.",
  "Ihre Bemühungen um eine schnelle Lösung wurden von allen Beteiligten sehr geschätzt.",
  "Die Auswertung der Umfrage zeigt, dass die Zufriedenheit insgesamt gestiegen ist.",
  "Wir planen, das Büro im Frühjahr umzugestalten, um mehr Tageslicht zu nutzen.",
]

const EN_SENTENCES = [
  "We discussed the handover process and agreed on the next steps for the transition.",
  "The heating system has been running smoothly since the last maintenance visit.",
  "Next week we need feedback from the caregiver before we can finalize the decision.",
  "There were a few misunderstandings about the handover times that we should clarify.",
  "The technician recommends checking the heat exchanger again in the spring.",
  "Nicole mentioned that communication between departments needs to improve significantly.",
  "We should adjust the opening hours during the transition phase for everyone's benefit.",
  "The minutes from the last meeting already capture the key decisions we made.",
  "Someone suggested scheduling an additional café meeting sometime in November.",
  "Parent feedback was overwhelmingly positive, though a few questions remain open.",
  "We need to double check the notice periods before signing the résumé of the contract.",
  "The refrigerator in the kitchen was replaced and the invoice is attached to this note.",
  "Their efforts to find a quick solution were genuinely appreciated by everyone involved.",
  "The survey results show that overall satisfaction has increased since last quarter.",
  "We are planning to redesign the office in spring to make better use of daylight.",
]

const TOPICS = [
  "Kita-Übergabe",
  "Heizungswartung",
  "Projektstatus",
  "Team-Meeting",
  "Elterngespräch",
  "budget review",
  "client follow-up",
  "naïve prototype walkthrough",
  "Wärmepumpe Inspektion",
  "quarterly planning",
]

function paragraph(rng, targetChars) {
  const pool = shuffle(rng, [...DE_SENTENCES, ...EN_SENTENCES])
  let out = ""
  let i = 0
  while (out.length < targetChars) {
    out += pool[i % pool.length] + " "
    i++
    if (i % pool.length === 0) {
      // reshuffle to avoid an obviously periodic repeat pattern
      pool.splice(0, pool.length, ...shuffle(rng, pool))
    }
  }
  return out.trim()
}

/** ~targetChars of mixed DE/EN transcript text, unique per index. */
export function randomTranscript(index, targetChars = 14000) {
  const rng = mulberry32(index * 2654435761 + 1)
  const topic = pick(rng, TOPICS)
  const header = `Aufnahme #${index} — Thema: ${topic} (café Besprechung, Genève-Büro). `
  return header + paragraph(rng, targetChars - header.length)
}

export function randomSummary(index) {
  const rng = mulberry32(index * 40503 + 7)
  const topic = pick(rng, TOPICS)
  return (
    `Zusammenfassung #${index}: Besprochen wurde ${topic}. ` +
    pick(rng, DE_SENTENCES) +
    " " +
    pick(rng, EN_SENTENCES)
  )
}

export function randomKeyPoints(index) {
  const rng = mulberry32(index * 97 + 13)
  const n = 3 + Math.floor(rng() * 3) // 3-5
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(`Punkt ${i + 1}/${index}: ${pick(rng, [...DE_SENTENCES, ...EN_SENTENCES])}`)
  }
  return out
}

export function randomActionItems(index) {
  const rng = mulberry32(index * 131 + 29)
  const n = 2 + Math.floor(rng() * 2) // 2-3
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      who: pick(rng, ["Nico", "Nicole", "Herr Özdemir", "Frau Müller", "team"]),
      what: `Aktion ${i + 1} für Aufnahme ${index}: ${pick(rng, DE_SENTENCES)}`,
    })
  }
  return out
}
