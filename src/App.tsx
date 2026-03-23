import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WordPair {
  word: string
  translation: string
}

interface WordHistory {
  word: string
  timesSeen: number
  timesCorrect: number
  lastPracticed: number
}

interface SavedList {
  id: string
  name: string
  words: WordPair[]
  targetLang: string
  nativeLang: string
  mastery: number
  lastPracticed: number
}

interface StageResult {
  word: string
  translation: string
  correct: boolean
}

interface GlobalStats {
  totalWords: number
  totalSessions: number
  currentStreak: number
  lastSessionDate: string
}

type Stage = 'input' | 'encounter' | 'recognize' | 'recall' | 'produce' | 'master' | 'results'
type MixedFormat = 'mc-word' | 'mc-translation' | 'type-word' | 'type-translation'

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'vocab-lifecycle-lists'
const HISTORY_KEY = 'vocab-lifecycle-history'
const STATS_KEY = 'vocab-lifecycle-stats'
const THEME_KEY = 'vocab-lifecycle-theme'

const LANGUAGES = [
  'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch',
  'Russian', 'Japanese', 'Korean', 'Chinese', 'Arabic', 'Hebrew',
  'Turkish', 'Polish', 'Swedish', 'Norwegian', 'Danish', 'Finnish',
  'Greek', 'Hindi', 'Thai', 'Vietnamese', 'Indonesian', 'Czech',
  'Romanian', 'Hungarian', 'Ukrainian', 'Other',
]
const RTL_LANGUAGES = ['Arabic', 'Hebrew']
const SESSION_SIZES = [5, 10, 15, 20]

const STAGE_META: Record<string, { num: number; label: string; icon: string }> = {
  encounter: { num: 1, label: 'See & Hear', icon: '\u{1F441}' },
  recognize: { num: 2, label: 'Choose', icon: '\u{1F3AF}' },
  recall:    { num: 3, label: 'Type It', icon: '\u2328' },
  produce:   { num: 4, label: 'Use It', icon: '\u{1F4AC}' },
  master:    { num: 5, label: 'Master', icon: '\u{1F3C6}' },
}

const HUB_BASE = 'http://localhost:8420'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseWords(raw: string): WordPair[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const eqIdx = line.indexOf('=')
      if (eqIdx > 0) {
        return { word: line.slice(0, eqIdx).trim(), translation: line.slice(eqIdx + 1).trim() }
      }
      return { word: line, translation: '' }
    })
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[])
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
  return dp[m][n]
}

function isCloseEnough(input: string, target: string): boolean {
  const a = input.toLowerCase().trim()
  const b = target.toLowerCase().trim()
  if (a === b) return true
  if (b.length > 4) return levenshtein(a, b) <= 1
  return false
}

function speakWord(text: string, lang: string) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const langMap: Record<string, string> = {
    Spanish: 'es', French: 'fr', German: 'de', Italian: 'it',
    Portuguese: 'pt', Dutch: 'nl', Russian: 'ru', Japanese: 'ja',
    Korean: 'ko', Chinese: 'zh', Arabic: 'ar', Hebrew: 'he',
    Turkish: 'tr', Polish: 'pl', Swedish: 'sv', Norwegian: 'no',
    Danish: 'da', Finnish: 'fi', Greek: 'el', Hindi: 'hi',
    Thai: 'th', Vietnamese: 'vi', Indonesian: 'id', Czech: 'cs',
    Romanian: 'ro', Hungarian: 'hu', Ukrainian: 'uk',
  }
  u.lang = langMap[lang] || 'en'
  u.rate = 0.85
  window.speechSynthesis.speak(u)
}

function loadLists(): SavedList[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}
function saveLists(lists: SavedList[]) { localStorage.setItem(STORAGE_KEY, JSON.stringify(lists)) }

function loadHistory(): Record<string, WordHistory> {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}') } catch { return {} }
}
function saveHistory(h: Record<string, WordHistory>) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)) }

function loadStats(): GlobalStats {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) || '{}') as GlobalStats
  } catch { return { totalWords: 0, totalSessions: 0, currentStreak: 0, lastSessionDate: '' } }
}
function saveStats(s: GlobalStats) { localStorage.setItem(STATS_KEY, JSON.stringify(s)) }

function uid(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }

function todayStr(): string { return new Date().toISOString().slice(0, 10) }

// ─── Creative Hub ─────────────────────────────────────────────────────────────

async function hubAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${HUB_BASE}/health`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}

async function hubGenerate(prompt: string): Promise<string | null> {
  try {
    const r = await fetch(`${HUB_BASE}/generate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, max_tokens: 512 }),
    })
    if (!r.ok) return null
    const data = await r.json()
    const jobId = data.job_id
    if (!jobId) return data.text || data.response || null

    // Poll for completion
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 2000))
      const jr = await fetch(`${HUB_BASE}/jobs/${jobId}`)
      if (!jr.ok) continue
      const job = await jr.json()
      if (job.status === 'completed') {
        return job.result?.text || job.result?.response || job.output?.text || null
      }
      if (job.status === 'failed') return null
    }
    return null
  } catch { return null }
}

// ─── Confetti ─────────────────────────────────────────────────────────────────

function Confetti() {
  const particles = useMemo(() =>
    Array.from({ length: 60 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      delay: Math.random() * 0.6,
      duration: 1.5 + Math.random() * 1.5,
      size: 4 + Math.random() * 6,
      color: ['var(--green-main)', 'var(--pink)', 'var(--green-light)', 'var(--pink-mid)', 'var(--green-bright)', '#F59E0B'][
        Math.floor(Math.random() * 6)
      ],
      drift: (Math.random() - 0.5) * 60,
      rotation: Math.random() * 360,
    })),
  [])

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 100, overflow: 'hidden' }}>
      {particles.map((p) => (
        <motion.div
          key={p.id}
          initial={{ y: -20, x: `${p.x}vw`, opacity: 1, rotate: 0 }}
          animate={{ y: '105vh', x: `calc(${p.x}vw + ${p.drift}px)`, opacity: 0, rotate: p.rotation + 360 }}
          transition={{ duration: p.duration, delay: p.delay, ease: 'easeIn' }}
          style={{
            position: 'absolute',
            width: p.size,
            height: p.size * 1.5,
            background: p.color,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  )
}

// ─── Stage Progress Bar ───────────────────────────────────────────────────────

function StageBar({ current }: { current: Stage }) {
  const stages = ['encounter', 'recognize', 'recall', 'produce', 'master'] as const
  const idx = stages.indexOf(current as typeof stages[number])

  return (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'center', padding: '20px 16px 0', maxWidth: 640, margin: '0 auto', width: '100%' }}>
      {stages.map((s, i) => {
        const meta = STAGE_META[s]
        const isActive = i === idx
        const isDone = i < idx || current === 'results'
        return (
          <div key={s} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                height: 4,
                width: '100%',
                borderRadius: 2,
                background: isDone ? 'var(--green-main)' : isActive ? 'var(--pink)' : 'var(--border)',
                transition: 'background 0.3s',
              }}
            />
            <span
              style={{
                fontSize: 10,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--pink)' : isDone ? 'var(--green-main)' : 'var(--text-dim)',
                transition: 'color 0.3s',
                whiteSpace: 'nowrap',
              }}
            >
              {meta.icon} {meta.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Shared Card Wrapper ──────────────────────────────────────────────────────

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: 32,
        width: '100%',
        maxWidth: 560,
        margin: '0 auto',
        ...style,
      }}
    >
      {children}
    </motion.div>
  )
}

// ─── Dark mode toggle button ──────────────────────────────────────────────────

function ThemeToggle({ theme, toggle }: { theme: string; toggle: () => void }) {
  return (
    <button
      onClick={toggle}
      style={{
        padding: '6px 12px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-alt)',
        border: '1px solid var(--border)',
        fontSize: 14,
        color: 'var(--text-secondary)',
        transition: 'all 0.2s',
      }}
    >
      {theme === 'dark' ? '\u2600\uFE0F' : '\u{1F319}'}
    </button>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  // ── Theme
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light')
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  // ── Global state
  const [stage, setStage] = useState<Stage>('input')
  const [allWords, setAllWords] = useState<WordPair[]>([])
  const [sessionWords, setSessionWords] = useState<WordPair[]>([])
  const [targetLang, setTargetLang] = useState('Spanish')
  const [nativeLang, setNativeLang] = useState('English')
  const [sessionSize, setSessionSize] = useState(10)
  const [rawInput, setRawInput] = useState('')
  const [savedLists, setSavedLists] = useState<SavedList[]>(loadLists)
  const [activeListId, setActiveListId] = useState<string | null>(null)
  const [hubUp, setHubUp] = useState(false)
  const [translating, setTranslating] = useState(false)

  // ── Stage 1: Encounter
  const [encIndex, setEncIndex] = useState(0)
  const [encRevealed, setEncRevealed] = useState(false)
  const [encExamples, setEncExamples] = useState<Record<number, string>>({})
  const encTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Stage 2: Recognize
  const [recIndex, setRecIndex] = useState(0)
  const [recScore, setRecScore] = useState(0)
  const [, setRecResults] = useState<StageResult[]>([])
  const [recFeedback, setRecFeedback] = useState<'correct' | 'wrong' | null>(null)
  const [recCorrectAnswer, setRecCorrectAnswer] = useState('')
  const [recOptions, setRecOptions] = useState<string[]>([])
  const [recAnswered, setRecAnswered] = useState(false)

  // ── Stage 3: Recall
  const [typIndex, setTypIndex] = useState(0)
  const [typScore, setTypScore] = useState(0)
  const [, setTypResults] = useState<StageResult[]>([])
  const [typFeedback, setTypFeedback] = useState<'correct' | 'wrong' | null>(null)
  const [typCorrectAnswer, setTypCorrectAnswer] = useState('')
  const [typInput, setTypInput] = useState('')
  const [typAnswered, setTypAnswered] = useState(false)
  const typInputRef = useRef<HTMLInputElement>(null)

  // ── Stage 4: Produce
  const [prodIndex, setProdIndex] = useState(0)
  const [prodInput, setProdInput] = useState('')
  const [prodFeedback, setProdFeedback] = useState<string | null>(null)
  const [prodAnswered, setProdAnswered] = useState(false)
  const [, setProdResults] = useState<StageResult[]>([])
  const [prodChecking, setProdChecking] = useState(false)
  const prodInputRef = useRef<HTMLInputElement>(null)

  // ── Stage 5: Master (mixed)
  const [mixedItems, setMixedItems] = useState<Array<{ pair: WordPair; format: MixedFormat }>>([])
  const [mixedIndex, setMixedIndex] = useState(0)
  const [mixedScore, setMixedScore] = useState(0)
  const [mixedResults, setMixedResults] = useState<StageResult[]>([])
  const [mixedFeedback, setMixedFeedback] = useState<'correct' | 'wrong' | null>(null)
  const [mixedCorrectAnswer, setMixedCorrectAnswer] = useState('')
  const [mixedOptions, setMixedOptions] = useState<string[]>([])
  const [mixedInput, setMixedInput] = useState('')
  const [mixedAnswered, setMixedAnswered] = useState(false)
  const mixedInputRef = useRef<HTMLInputElement>(null)

  // ── Results
  const [showConfetti, setShowConfetti] = useState(false)

  // ── Timer
  const [stageStartTime, setStageStartTime] = useState(0)
  const [stageElapsed, setStageElapsed] = useState(0)

  const isRtl = RTL_LANGUAGES.includes(targetLang)

  // ── Check hub on mount
  useEffect(() => { hubAvailable().then(setHubUp) }, [])

  // ── Timer tick
  useEffect(() => {
    if (stage === 'input' || stage === 'results') return
    const iv = setInterval(() => {
      setStageElapsed(Math.floor((Date.now() - stageStartTime) / 1000))
    }, 1000)
    return () => clearInterval(iv)
  }, [stage, stageStartTime])

  // ── Generate MC options for recognize stage
  const generateRecOptions = useCallback(
    (idx: number) => {
      const correct = sessionWords[idx].translation
      const others = sessionWords.filter((_, i) => i !== idx).map((w) => w.translation)
      const distractors = shuffle(others).slice(0, 3)
      while (distractors.length < 3) distractors.push('\u2014')
      setRecOptions(shuffle([correct, ...distractors]))
    },
    [sessionWords],
  )

  // ── Generate mixed items
  const generateMixedItems = useCallback(() => {
    const formats: MixedFormat[] = ['mc-word', 'mc-translation', 'type-word', 'type-translation']
    const items = sessionWords.map((pair) => ({
      pair,
      format: formats[Math.floor(Math.random() * formats.length)],
    }))
    setMixedItems(shuffle(items))
  }, [sessionWords])

  // ── Generate MC options for mixed stage
  const generateMixedOptions = useCallback(
    (idx: number) => {
      if (!mixedItems[idx]) return
      const { pair, format } = mixedItems[idx]
      if (format === 'mc-word') {
        const correct = pair.translation
        const others = sessionWords.filter((w) => w.word !== pair.word).map((w) => w.translation)
        const distractors = shuffle(others).slice(0, 3)
        while (distractors.length < 3) distractors.push('\u2014')
        setMixedOptions(shuffle([correct, ...distractors]))
      } else if (format === 'mc-translation') {
        const correct = pair.word
        const others = sessionWords.filter((w) => w.word !== pair.word).map((w) => w.word)
        const distractors = shuffle(others).slice(0, 3)
        while (distractors.length < 3) distractors.push('\u2014')
        setMixedOptions(shuffle([correct, ...distractors]))
      }
    },
    [mixedItems, sessionWords],
  )

  // ── Start session
  const startSession = useCallback(
    (words: WordPair[], listId?: string) => {
      const selected = shuffle(words).slice(0, sessionSize)
      setAllWords(words)
      setSessionWords(selected)
      setActiveListId(listId || null)

      setEncIndex(0)
      setEncRevealed(false)
      setEncExamples({})

      setRecIndex(0); setRecScore(0); setRecResults([]); setRecFeedback(null); setRecAnswered(false)
      setTypIndex(0); setTypScore(0); setTypResults([]); setTypFeedback(null); setTypInput(''); setTypAnswered(false)
      setProdIndex(0); setProdInput(''); setProdFeedback(null); setProdAnswered(false); setProdResults([])
      setMixedIndex(0); setMixedScore(0); setMixedResults([]); setMixedFeedback(null); setMixedInput(''); setMixedAnswered(false)
      setShowConfetti(false)
      setStageStartTime(Date.now())
      setStageElapsed(0)

      setStage('encounter')
    },
    [sessionSize],
  )

  // ── Encounter: auto-reveal translation after 2s
  useEffect(() => {
    if (stage !== 'encounter') return
    setEncRevealed(false)
    if (encTimerRef.current) clearTimeout(encTimerRef.current)
    encTimerRef.current = setTimeout(() => setEncRevealed(true), 2000)
    return () => { if (encTimerRef.current) clearTimeout(encTimerRef.current) }
  }, [stage, encIndex])

  // ── Encounter: fetch AI example sentence
  useEffect(() => {
    if (stage !== 'encounter' || !hubUp) return
    if (encExamples[encIndex] !== undefined) return
    const w = sessionWords[encIndex]
    if (!w) return
    hubGenerate(`Write one simple example sentence in ${targetLang} using the word "${w.word}". Just the sentence, nothing else.`)
      .then((text) => {
        if (text) setEncExamples((prev) => ({ ...prev, [encIndex]: text.trim() }))
      })
  }, [stage, encIndex, hubUp, sessionWords, targetLang, encExamples])

  // ── Effects: set up options when index changes
  useEffect(() => {
    if (stage === 'recognize' && sessionWords.length > 0 && recIndex < sessionWords.length) {
      generateRecOptions(recIndex)
      setRecFeedback(null)
      setRecAnswered(false)
    }
  }, [stage, recIndex, sessionWords, generateRecOptions])

  useEffect(() => {
    if (stage === 'recall' && typInputRef.current) typInputRef.current.focus()
  }, [stage, typIndex])

  useEffect(() => {
    if (stage === 'produce' && prodInputRef.current) prodInputRef.current.focus()
  }, [stage, prodIndex])

  useEffect(() => {
    if (stage === 'master' && mixedItems.length > 0 && mixedIndex < mixedItems.length) {
      generateMixedOptions(mixedIndex)
      setMixedFeedback(null)
      setMixedInput('')
      setMixedAnswered(false)
      setTimeout(() => { if (mixedInputRef.current) mixedInputRef.current.focus() }, 100)
    }
  }, [stage, mixedIndex, mixedItems, generateMixedOptions])

  // ── Keyboard handler
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (stage === 'encounter' && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault()
        if (!encRevealed) { setEncRevealed(true); return }
        if (encIndex < sessionWords.length - 1) setEncIndex((i) => i + 1)
        else { setStage('recognize'); setStageStartTime(Date.now()); setStageElapsed(0) }
      }

      if (stage === 'recognize' && !recAnswered && ['1', '2', '3', '4'].includes(e.key)) {
        const idx = parseInt(e.key) - 1
        if (recOptions[idx]) handleRecAnswer(recOptions[idx])
      }

      if (stage === 'master' && !mixedAnswered && mixedItems[mixedIndex]) {
        const { format } = mixedItems[mixedIndex]
        if ((format === 'mc-word' || format === 'mc-translation') && ['1', '2', '3', '4'].includes(e.key)) {
          const idx = parseInt(e.key) - 1
          if (mixedOptions[idx]) handleMixedAnswer(mixedOptions[idx])
        }
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, encIndex, encRevealed, sessionWords, recAnswered, recOptions, mixedAnswered, mixedItems, mixedIndex, mixedOptions])

  // ── Stage handlers ──────────────────────────────────────────────────────────

  function handleRecAnswer(answer: string) {
    if (recAnswered) return
    setRecAnswered(true)
    const correct = sessionWords[recIndex].translation
    const isCorrect = answer === correct
    if (isCorrect) { setRecScore((s) => s + 1); setRecFeedback('correct') }
    else { setRecFeedback('wrong'); setRecCorrectAnswer(correct) }
    setRecResults((r) => [...r, { word: sessionWords[recIndex].word, translation: correct, correct: isCorrect }])
    setTimeout(() => {
      if (recIndex < sessionWords.length - 1) {
        setRecIndex((i) => i + 1)
      } else {
        const finalScore = isCorrect ? recScore + 1 : recScore
        const pct = (finalScore / sessionWords.length) * 100
        if (pct >= 70) {
          setTypIndex(0); setTypScore(0); setTypResults([]); setTypFeedback(null); setTypInput(''); setTypAnswered(false)
          setStage('recall'); setStageStartTime(Date.now()); setStageElapsed(0)
        } else {
          setRecIndex(0); setRecScore(0); setRecResults([])
        }
      }
    }, isCorrect ? 500 : 1500)
  }

  function handleTypSubmit() {
    if (typAnswered || !typInput.trim()) return
    setTypAnswered(true)
    const correct = sessionWords[typIndex].word
    const isCorrect = isCloseEnough(typInput, correct)
    if (isCorrect) { setTypScore((s) => s + 1); setTypFeedback('correct') }
    else { setTypFeedback('wrong'); setTypCorrectAnswer(correct) }
    setTypResults((r) => [...r, { word: correct, translation: sessionWords[typIndex].translation, correct: isCorrect }])
    setTimeout(() => {
      if (typIndex < sessionWords.length - 1) {
        setTypIndex((i) => i + 1); setTypInput(''); setTypFeedback(null); setTypAnswered(false)
        setTimeout(() => typInputRef.current?.focus(), 50)
      } else {
        const finalScore = isCorrect ? typScore + 1 : typScore
        const pct = (finalScore / sessionWords.length) * 100
        if (pct >= 60) {
          setProdIndex(0); setProdInput(''); setProdFeedback(null); setProdAnswered(false); setProdResults([])
          setStage('produce'); setStageStartTime(Date.now()); setStageElapsed(0)
        } else {
          setTypIndex(0); setTypScore(0); setTypResults([]); setTypInput(''); setTypFeedback(null); setTypAnswered(false)
        }
      }
    }, isCorrect ? 500 : 1500)
  }

  async function handleProdSubmit() {
    if (prodAnswered || !prodInput.trim()) return
    setProdAnswered(true)

    if (hubUp) {
      setProdChecking(true)
      const result = await hubGenerate(
        `The user wrote a sentence in ${targetLang} using the word "${sessionWords[prodIndex].word}": "${prodInput}". ` +
        `Is this sentence grammatically correct and does it properly use the word? Reply with CORRECT or INCORRECT followed by a brief explanation (1 sentence max).`
      )
      setProdChecking(false)
      if (result) {
        const isCorrect = result.toUpperCase().startsWith('CORRECT')
        setProdFeedback(result)
        setProdResults((r) => [...r, { word: sessionWords[prodIndex].word, translation: sessionWords[prodIndex].translation, correct: isCorrect }])
      } else {
        setProdFeedback('Could not check - marked as attempted')
        setProdResults((r) => [...r, { word: sessionWords[prodIndex].word, translation: sessionWords[prodIndex].translation, correct: true }])
      }
    } else {
      setProdFeedback(null)
    }
  }

  function handleProdSelfRate(correct: boolean) {
    setProdResults((r) => [...r, { word: sessionWords[prodIndex].word, translation: sessionWords[prodIndex].translation, correct }])
    advanceProd()
  }

  function advanceProd() {
    if (prodIndex < sessionWords.length - 1) {
      setProdIndex((i) => i + 1); setProdInput(''); setProdFeedback(null); setProdAnswered(false)
      setTimeout(() => prodInputRef.current?.focus(), 50)
    } else {
      generateMixedItems()
      setMixedIndex(0); setMixedScore(0); setMixedResults([])
      setStage('master'); setStageStartTime(Date.now()); setStageElapsed(0)
    }
  }

  function handleMixedAnswer(answer: string) {
    if (mixedAnswered) return
    setMixedAnswered(true)
    const { pair, format } = mixedItems[mixedIndex]
    let correct: string
    let isCorrect: boolean

    if (format === 'mc-word') {
      correct = pair.translation; isCorrect = answer === correct
    } else if (format === 'mc-translation') {
      correct = pair.word; isCorrect = answer === correct
    } else if (format === 'type-word') {
      correct = pair.word; isCorrect = isCloseEnough(answer, correct)
    } else {
      correct = pair.translation; isCorrect = isCloseEnough(answer, correct)
    }

    if (isCorrect) { setMixedScore((s) => s + 1); setMixedFeedback('correct') }
    else { setMixedFeedback('wrong'); setMixedCorrectAnswer(correct) }
    setMixedResults((r) => [...r, { word: pair.word, translation: pair.translation, correct: isCorrect }])

    setTimeout(() => {
      if (mixedIndex < mixedItems.length - 1) setMixedIndex((i) => i + 1)
      else {
        finishSession(isCorrect ? mixedScore + 1 : mixedScore)
      }
    }, isCorrect ? 500 : 1500)
  }

  function handleMixedTypeSubmit() {
    if (mixedAnswered || !mixedInput.trim()) return
    handleMixedAnswer(mixedInput)
  }

  function finishSession(finalMixedScore: number) {
    setStage('results')
    const pct = Math.round((finalMixedScore / sessionWords.length) * 100)
    if (pct >= 80) setShowConfetti(true)

    // Update word history
    const history = loadHistory()
    sessionWords.forEach((w) => {
      const key = `${w.word}|${targetLang}`
      const existing = history[key] || { word: w.word, timesSeen: 0, timesCorrect: 0, lastPracticed: 0 }
      existing.timesSeen += 1
      const wasCorrect = mixedResults.find((r) => r.word === w.word)?.correct
      if (wasCorrect) existing.timesCorrect += 1
      existing.lastPracticed = Date.now()
      history[key] = existing
    })
    saveHistory(history)

    // Update global stats
    const stats = loadStats()
    const today = todayStr()
    stats.totalSessions = (stats.totalSessions || 0) + 1
    stats.totalWords = Object.keys(loadHistory()).length
    if (stats.lastSessionDate === today) {
      // same day
    } else {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      if (stats.lastSessionDate === yesterday.toISOString().slice(0, 10)) {
        stats.currentStreak = (stats.currentStreak || 0) + 1
      } else {
        stats.currentStreak = 1
      }
    }
    stats.lastSessionDate = today
    saveStats(stats)
  }

  function saveListProgress() {
    const mastery = mixedResults.length > 0
      ? Math.round((mixedResults.filter((r) => r.correct).length / mixedResults.length) * 100)
      : 0
    const lists = loadLists()
    if (activeListId) {
      const idx = lists.findIndex((l) => l.id === activeListId)
      if (idx >= 0) { lists[idx].mastery = mastery; lists[idx].lastPracticed = Date.now() }
    } else {
      lists.push({
        id: uid(),
        name: `${sessionWords[0]?.word || 'List'} +${sessionWords.length - 1}`,
        words: allWords,
        targetLang, nativeLang, mastery,
        lastPracticed: Date.now(),
      })
    }
    saveLists(lists)
    setSavedLists(lists)
  }

  function practiceWeak() {
    const weakWords = mixedResults.filter((r) => !r.correct).map((r) => ({ word: r.word, translation: r.translation }))
    if (weakWords.length >= 3) startSession(weakWords, activeListId ?? undefined)
    else { alert('Need at least 3 weak words to practice. Try a new list!') }
  }

  function exportResults() {
    const mastery = mixedResults.length > 0
      ? Math.round((mixedResults.filter((r) => r.correct).length / mixedResults.length) * 100)
      : 0
    const lines = [
      `Life of a Vocab - Results`,
      `Mastery: ${mastery}%`,
      `${mixedResults.filter((r) => r.correct).length}/${mixedResults.length} correct`,
      ``,
      ...mixedResults.map((r) => `${r.correct ? '\u2713' : '\u2717'} ${r.word} = ${r.translation}`),
    ]
    navigator.clipboard.writeText(lines.join('\n'))
  }

  async function autoTranslate() {
    if (!hubUp) return
    const wordsOnly = parseWords(rawInput).filter((w) => w.word && !w.translation)
    if (wordsOnly.length === 0) return
    setTranslating(true)
    const wordList = wordsOnly.map((w) => w.word).join(', ')
    const result = await hubGenerate(
      `Translate each of these ${targetLang} words to ${nativeLang}. Reply with ONLY the translations, one per line, in the same order. Words: ${wordList}`
    )
    setTranslating(false)
    if (result) {
      const translations = result.split('\n').map((l: string) => l.trim()).filter(Boolean)
      const newLines = wordsOnly.map((w, i) => `${w.word} = ${translations[i] || '???'}`)
      setRawInput(newLines.join('\n'))
    }
  }

  // ── Computed
  const parsedWords = useMemo(() => parseWords(rawInput), [rawInput])
  const validWords = parsedWords.filter((w) => w.word && w.translation)
  const hasUntranslated = parsedWords.some((w) => w.word && !w.translation)

  const mastery = mixedResults.length > 0
    ? Math.round((mixedResults.filter((r) => r.correct).length / mixedResults.length) * 100)
    : 0

  const globalStats = loadStats()

  function fmtTime(s: number) {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`
  }

  // ── Styles
  const btnBase: CSSProperties = {
    padding: '12px 24px',
    borderRadius: 'var(--radius)',
    fontWeight: 600,
    fontSize: 15,
    transition: 'all 0.15s',
    cursor: 'pointer',
  }
  const btnGreen: CSSProperties = {
    ...btnBase,
    background: 'var(--green-main)',
    color: '#fff',
  }
  const btnPink: CSSProperties = {
    ...btnBase,
    background: 'var(--pink)',
    color: '#fff',
  }
  const btnSurface: CSSProperties = {
    ...btnBase,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
  }
  const btnOption: CSSProperties = {
    ...btnBase,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    width: '100%',
    textAlign: 'left' as const,
    padding: '14px 20px',
    fontSize: 16,
  }

  function deleteList(id: string) {
    const lists = loadLists().filter((l) => l.id !== id)
    saveLists(lists)
    setSavedLists(lists)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {showConfetti && <Confetti />}

      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
        }}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
          onClick={() => { setStage('input'); setRawInput(''); setShowConfetti(false) }}
        >
          <span style={{ fontSize: 22 }}>{'\u{1F331}'}</span>
          <span style={{ fontWeight: 700, fontSize: 17, color: 'var(--green-dark)' }}>
            Life of a Vocab
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {stage !== 'input' && stage !== 'results' && (
            <span style={{ fontSize: 12, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtTime(stageElapsed)}
            </span>
          )}
          {hubUp && (
            <span style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 99, background: 'var(--green-faded)',
              color: 'var(--green-main)', fontWeight: 600,
            }}>
              AI
            </span>
          )}
          <ThemeToggle theme={theme} toggle={toggleTheme} />
        </div>
      </header>

      {stage !== 'input' && stage !== 'results' && <StageBar current={stage} />}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px 16px 48px' }}>
        <AnimatePresence mode="wait">

          {/* ── INPUT STAGE ──────────────────────────────────────────── */}
          {stage === 'input' && (
            <motion.div
              key="input"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{ width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 24 }}
            >
              <div style={{ textAlign: 'center', marginBottom: 8 }}>
                <h1 style={{ fontSize: 32, fontWeight: 800, margin: 0, letterSpacing: -0.5, color: 'var(--green-dark)' }}>
                  {'\u{1F331}'} Life of a Vocab
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: 15, marginTop: 6 }}>
                  From encounter to mastery
                </p>
              </div>

              {/* Global stats */}
              {(globalStats.totalSessions > 0) && (
                <div style={{
                  display: 'flex', justifyContent: 'center', gap: 24,
                  padding: '12px 16px', background: 'var(--green-pale)', borderRadius: 'var(--radius)',
                  border: '1px solid var(--green-faded)',
                }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--green-main)' }}>{globalStats.totalWords || 0}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>words</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--green-main)' }}>{globalStats.totalSessions || 0}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>sessions</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--pink)' }}>{globalStats.currentStreak || 0}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>streak</div>
                  </div>
                </div>
              )}

              {/* Textarea */}
              <div>
                <textarea
                  value={rawInput}
                  onChange={(e) => setRawInput(e.target.value)}
                  placeholder={"casa = house\nperro = dog\ngato = cat\n\nOr paste words only:\ncasa\nperro\ngato"}
                  style={{ minHeight: 180, lineHeight: 1.7 }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                    {validWords.length} word{validWords.length !== 1 ? 's' : ''} ready
                    {hasUntranslated && ` \u00B7 ${parsedWords.filter((w) => w.word && !w.translation).length} need translation`}
                  </p>
                  {hubUp && hasUntranslated && (
                    <button
                      onClick={autoTranslate}
                      disabled={translating}
                      style={{
                        fontSize: 13, color: 'var(--pink)', fontWeight: 600, cursor: 'pointer',
                        opacity: translating ? 0.5 : 1,
                      }}
                    >
                      {translating ? 'Translating...' : '\u2728 Auto-Translate'}
                    </button>
                  )}
                </div>
              </div>

              {/* Language selectors */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
                    Target language:
                  </label>
                  <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)}>
                    {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
                    Native language:
                  </label>
                  <select value={nativeLang} onChange={(e) => setNativeLang(e.target.value)}>
                    <option value="English">English</option>
                    {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              </div>

              {/* Session size */}
              <div>
                <label style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8, display: 'block' }}>
                  Words per session:
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {SESSION_SIZES.map((n) => (
                    <button
                      key={n}
                      onClick={() => setSessionSize(n)}
                      style={{
                        ...btnBase,
                        flex: 1,
                        padding: '10px 0',
                        background: n === sessionSize ? 'var(--pink-faded)' : 'var(--surface)',
                        border: `1px solid ${n === sessionSize ? 'var(--pink)' : 'var(--border)'}`,
                        color: n === sessionSize ? 'var(--pink)' : 'var(--text-dim)',
                        fontWeight: n === sessionSize ? 700 : 500,
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Start button */}
              <button
                onClick={() => { if (validWords.length >= 3) startSession(validWords) }}
                disabled={validWords.length < 3}
                style={{
                  ...btnGreen,
                  fontSize: 17,
                  padding: '14px 32px',
                  opacity: validWords.length < 3 ? 0.4 : 1,
                  cursor: validWords.length < 3 ? 'not-allowed' : 'pointer',
                }}
              >
                {'\u{1F331}'} Start Journey
              </button>
              {validWords.length > 0 && validWords.length < 3 && (
                <p style={{ fontSize: 13, color: 'var(--incorrect)', textAlign: 'center' }}>
                  Add at least 3 words with translations (word = translation)
                </p>
              )}

              {/* Saved lists */}
              {savedLists.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12 }}>
                    Saved Lists
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {savedLists.map((list) => (
                      <div
                        key={list.id}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          background: 'var(--surface)', border: '1px solid var(--border)',
                          borderRadius: 'var(--radius)', padding: '12px 16px',
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{list.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                            {list.words.length} words &middot;{' '}
                            <span style={{ color: list.mastery >= 80 ? 'var(--green-main)' : list.mastery >= 50 ? 'var(--yellow)' : 'var(--incorrect)' }}>
                              {list.mastery}%
                            </span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => { setTargetLang(list.targetLang); setNativeLang(list.nativeLang); startSession(list.words, list.id) }}
                            style={{ ...btnBase, padding: '6px 14px', fontSize: 13, background: 'var(--green-faded)', color: 'var(--green-main)', border: '1px solid var(--green-main)' }}
                          >
                            Practice
                          </button>
                          <button
                            onClick={() => deleteList(list.id)}
                            style={{ ...btnBase, padding: '6px 10px', fontSize: 13, color: 'var(--text-dim)', border: '1px solid var(--border)' }}
                          >
                            &times;
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ── STAGE 1: ENCOUNTER ─────────────────────────────────────── */}
          {stage === 'encounter' && sessionWords.length > 0 && (
            <motion.div key="encounter" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 560 }}>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 24 }}>
                {sessionWords.map((_, i) => (
                  <div
                    key={i}
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: i <= encIndex ? 'var(--green-main)' : 'var(--border)',
                      transition: 'background 0.2s',
                    }}
                  />
                ))}
              </div>

              <AnimatePresence mode="wait">
                <Card key={encIndex}>
                  <div
                    onClick={() => {
                      if (!encRevealed) { setEncRevealed(true); return }
                      if (encIndex < sessionWords.length - 1) setEncIndex((i) => i + 1)
                      else { setStage('recognize'); setStageStartTime(Date.now()); setStageElapsed(0) }
                    }}
                    style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'center' }}
                  >
                    <p style={{ fontSize: 42, fontWeight: 800, marginBottom: 12, direction: isRtl ? 'rtl' : 'ltr', color: 'var(--green-dark)' }}>
                      {sessionWords[encIndex].word}
                    </p>

                    <AnimatePresence>
                      {encRevealed && sessionWords[encIndex].translation && (
                        <motion.p
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          style={{ fontSize: 20, color: 'var(--text-secondary)', marginBottom: 8 }}
                        >
                          {sessionWords[encIndex].translation}
                        </motion.p>
                      )}
                    </AnimatePresence>

                    {encExamples[encIndex] && encRevealed && (
                      <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        style={{ fontSize: 14, color: 'var(--pink)', fontStyle: 'italic', marginTop: 12, lineHeight: 1.5 }}
                      >
                        {encExamples[encIndex]}
                      </motion.p>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 24 }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); speakWord(sessionWords[encIndex].word, targetLang) }}
                      style={{ ...btnSurface, padding: '8px 20px', fontSize: 14 }}
                    >
                      {'\u{1F50A}'} Listen
                    </button>
                  </div>

                  <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 20, textAlign: 'center' }}>
                    {encRevealed ? 'Tap card or press Space to continue' : 'Translation reveals in a moment...'}
                  </p>
                </Card>
              </AnimatePresence>

              {encIndex === sessionWords.length - 1 && encRevealed && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 24, textAlign: 'center' }}>
                  <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 12 }}>
                    You've seen all {sessionWords.length} words. Ready to test yourself?
                  </p>
                  <button onClick={() => { setStage('recognize'); setStageStartTime(Date.now()); setStageElapsed(0) }} style={btnGreen}>
                    Start Stage 2 &rarr;
                  </button>
                </motion.div>
              )}
            </motion.div>
          )}

          {/* ── STAGE 2: RECOGNIZE ─────────────────────────────────────── */}
          {stage === 'recognize' && sessionWords.length > 0 && (
            <motion.div key="recognize" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 560 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{recIndex + 1} / {sessionWords.length}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--green-main)' }}>
                  {recScore}/{recIndex + (recAnswered ? 1 : 0)} (need 70%)
                </span>
              </div>

              <AnimatePresence mode="wait">
                <Card key={recIndex}>
                  <p style={{ fontSize: 32, fontWeight: 800, marginBottom: 28, direction: isRtl ? 'rtl' : 'ltr', color: 'var(--green-dark)' }}>
                    {sessionWords[recIndex].word}
                  </p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {recOptions.map((opt, i) => {
                      const isCorrect = opt === sessionWords[recIndex].translation
                      return (
                        <motion.button
                          key={opt + i}
                          onClick={() => handleRecAnswer(opt)}
                          disabled={recAnswered}
                          whileHover={!recAnswered ? { scale: 1.01 } : {}}
                          whileTap={!recAnswered ? { scale: 0.98 } : {}}
                          style={{
                            ...btnOption,
                            background: recAnswered
                              ? isCorrect ? 'var(--correct-faded)' : 'var(--surface)'
                              : 'var(--surface)',
                            borderColor: recAnswered
                              ? isCorrect ? 'var(--correct)' : 'var(--border)'
                              : 'var(--border)',
                            opacity: recAnswered && !isCorrect ? 0.5 : 1,
                          }}
                        >
                          <span style={{ color: 'var(--text-dim)', marginRight: 10, fontSize: 13 }}>{i + 1}</span>
                          {opt}
                          {recAnswered && isCorrect && <span style={{ marginLeft: 'auto', color: 'var(--correct)' }}> {'\u2713'}</span>}
                        </motion.button>
                      )
                    })}
                  </div>

                  {recFeedback === 'wrong' && (
                    <motion.p initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
                      style={{ marginTop: 16, fontSize: 14, color: 'var(--incorrect)' }}
                    >
                      Correct answer: <strong>{recCorrectAnswer}</strong>
                    </motion.p>
                  )}
                </Card>
              </AnimatePresence>
            </motion.div>
          )}

          {/* ── STAGE 3: RECALL ───────────────────────────────────────── */}
          {stage === 'recall' && sessionWords.length > 0 && (
            <motion.div key="recall" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 560 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{typIndex + 1} / {sessionWords.length}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--green-main)' }}>
                  {typScore}/{typIndex + (typAnswered ? 1 : 0)} (need 60%)
                </span>
              </div>

              <AnimatePresence mode="wait">
                <Card key={typIndex}>
                  <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    What is the {targetLang} word for:
                  </p>
                  <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24, color: 'var(--green-dark)' }}>
                    {sessionWords[typIndex].translation || sessionWords[typIndex].word}
                  </p>

                  <form onSubmit={(e) => { e.preventDefault(); handleTypSubmit() }} style={{ display: 'flex', gap: 10 }}>
                    <input
                      ref={typInputRef}
                      type="text"
                      value={typInput}
                      onChange={(e) => setTypInput(e.target.value)}
                      disabled={typAnswered}
                      placeholder={`Type in ${targetLang}...`}
                      autoComplete="off"
                      autoCapitalize="off"
                      style={{
                        flex: 1,
                        borderColor: typFeedback === 'correct' ? 'var(--correct)' : typFeedback === 'wrong' ? 'var(--incorrect)' : undefined,
                        borderWidth: typFeedback ? 2 : 1,
                        direction: isRtl ? 'rtl' : 'ltr',
                      }}
                    />
                    <button
                      type="submit"
                      disabled={typAnswered || !typInput.trim()}
                      style={{ ...btnGreen, padding: '10px 20px', opacity: typAnswered || !typInput.trim() ? 0.4 : 1 }}
                    >
                      &crarr;
                    </button>
                  </form>

                  {!isRtl && targetLang !== 'English' && !typAnswered && (
                    <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
                      Tip: Switch to {targetLang} keyboard for special characters
                    </p>
                  )}

                  {typFeedback === 'correct' && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12, color: 'var(--correct)', fontWeight: 600 }}>
                      {'\u2713'} Correct!
                    </motion.p>
                  )}
                  {typFeedback === 'wrong' && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12, color: 'var(--incorrect)' }}>
                      Correct answer: <strong>{typCorrectAnswer}</strong>
                    </motion.p>
                  )}
                </Card>
              </AnimatePresence>
            </motion.div>
          )}

          {/* ── STAGE 4: PRODUCE ───────────────────────────────────────── */}
          {stage === 'produce' && sessionWords.length > 0 && (
            <motion.div key="produce" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 560 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{prodIndex + 1} / {sessionWords.length}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--pink)' }}>
                  Use it in a sentence
                </span>
              </div>

              <AnimatePresence mode="wait">
                <Card key={prodIndex}>
                  <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    Write a sentence using:
                  </p>
                  <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 4, color: 'var(--green-dark)', direction: isRtl ? 'rtl' : 'ltr' }}>
                    {sessionWords[prodIndex].word}
                  </p>
                  <p style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 20 }}>
                    ({sessionWords[prodIndex].translation})
                  </p>

                  <form onSubmit={(e) => { e.preventDefault(); handleProdSubmit() }} style={{ display: 'flex', gap: 10 }}>
                    <input
                      ref={prodInputRef}
                      type="text"
                      value={prodInput}
                      onChange={(e) => setProdInput(e.target.value)}
                      disabled={prodAnswered}
                      placeholder={`Write a sentence in ${targetLang}...`}
                      autoComplete="off"
                      style={{ flex: 1, direction: isRtl ? 'rtl' : 'ltr' }}
                    />
                    {!prodAnswered && (
                      <button
                        type="submit"
                        disabled={!prodInput.trim() || prodChecking}
                        style={{ ...btnPink, padding: '10px 20px', opacity: !prodInput.trim() || prodChecking ? 0.4 : 1 }}
                      >
                        {prodChecking ? '...' : hubUp ? 'Check' : 'Done'}
                      </button>
                    )}
                  </form>

                  {prodAnswered && prodFeedback && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12, fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {prodFeedback}
                    </motion.p>
                  )}

                  {prodAnswered && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'center' }}>
                      {!hubUp && !prodFeedback && (
                        <>
                          <button onClick={() => handleProdSelfRate(true)} style={{ ...btnGreen, padding: '8px 20px', fontSize: 14 }}>
                            Got it {'\u{1F44D}'}
                          </button>
                          <button onClick={() => handleProdSelfRate(false)} style={{ ...btnSurface, padding: '8px 20px', fontSize: 14 }}>
                            Not sure {'\u{1F914}'}
                          </button>
                        </>
                      )}
                      {(hubUp || prodFeedback) && (
                        <button onClick={advanceProd} style={{ ...btnGreen, padding: '8px 20px', fontSize: 14 }}>
                          Next &rarr;
                        </button>
                      )}
                    </div>
                  )}
                </Card>
              </AnimatePresence>
            </motion.div>
          )}

          {/* ── STAGE 5: MASTER (mixed) ──────────────────────────────── */}
          {stage === 'master' && mixedItems.length > 0 && mixedIndex < mixedItems.length && (
            <motion.div key="master" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 560 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{mixedIndex + 1} / {mixedItems.length}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--green-main)' }}>
                  {mixedScore}/{mixedIndex + (mixedAnswered ? 1 : 0)}
                </span>
              </div>

              <AnimatePresence mode="wait">
                <Card key={mixedIndex}>
                  {(() => {
                    const item = mixedItems[mixedIndex]
                    const { pair, format } = item

                    if (format === 'mc-word') {
                      return (
                        <>
                          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>Choose the translation:</p>
                          <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24, direction: isRtl ? 'rtl' : 'ltr', color: 'var(--green-dark)' }}>{pair.word}</p>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {mixedOptions.map((opt, i) => {
                              const isCorrectOpt = opt === pair.translation
                              return (
                                <button key={opt + i} onClick={() => handleMixedAnswer(opt)} disabled={mixedAnswered}
                                  style={{
                                    ...btnOption,
                                    background: mixedAnswered ? isCorrectOpt ? 'var(--correct-faded)' : 'var(--surface)' : 'var(--surface)',
                                    borderColor: mixedAnswered ? isCorrectOpt ? 'var(--correct)' : 'var(--border)' : 'var(--border)',
                                    opacity: mixedAnswered && !isCorrectOpt ? 0.5 : 1,
                                  }}
                                >
                                  <span style={{ color: 'var(--text-dim)', marginRight: 10, fontSize: 13 }}>{i + 1}</span>
                                  {opt}
                                  {mixedAnswered && isCorrectOpt && <span style={{ marginLeft: 'auto', color: 'var(--correct)' }}> {'\u2713'}</span>}
                                </button>
                              )
                            })}
                          </div>
                        </>
                      )
                    }

                    if (format === 'mc-translation') {
                      return (
                        <>
                          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>Choose the {targetLang} word:</p>
                          <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24, color: 'var(--green-dark)' }}>{pair.translation}</p>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {mixedOptions.map((opt, i) => {
                              const isCorrectOpt = opt === pair.word
                              return (
                                <button key={opt + i} onClick={() => handleMixedAnswer(opt)} disabled={mixedAnswered}
                                  style={{
                                    ...btnOption,
                                    background: mixedAnswered ? isCorrectOpt ? 'var(--correct-faded)' : 'var(--surface)' : 'var(--surface)',
                                    borderColor: mixedAnswered ? isCorrectOpt ? 'var(--correct)' : 'var(--border)' : 'var(--border)',
                                    opacity: mixedAnswered && !isCorrectOpt ? 0.5 : 1,
                                    direction: isRtl ? 'rtl' : 'ltr',
                                  }}
                                >
                                  <span style={{ color: 'var(--text-dim)', marginRight: 10, fontSize: 13 }}>{i + 1}</span>
                                  {opt}
                                  {mixedAnswered && isCorrectOpt && <span style={{ marginLeft: 'auto', color: 'var(--correct)' }}> {'\u2713'}</span>}
                                </button>
                              )
                            })}
                          </div>
                        </>
                      )
                    }

                    if (format === 'type-word') {
                      return (
                        <>
                          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>Type the {targetLang} word for:</p>
                          <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24, color: 'var(--green-dark)' }}>{pair.translation}</p>
                          <form onSubmit={(e) => { e.preventDefault(); handleMixedTypeSubmit() }} style={{ display: 'flex', gap: 10 }}>
                            <input ref={mixedInputRef} type="text" value={mixedInput} onChange={(e) => setMixedInput(e.target.value)}
                              disabled={mixedAnswered} placeholder={`Type in ${targetLang}...`} autoComplete="off" autoCapitalize="off"
                              style={{ flex: 1, direction: isRtl ? 'rtl' : 'ltr' }}
                            />
                            <button type="submit" disabled={mixedAnswered || !mixedInput.trim()}
                              style={{ ...btnGreen, padding: '10px 20px', opacity: mixedAnswered || !mixedInput.trim() ? 0.4 : 1 }}>
                              &crarr;
                            </button>
                          </form>
                        </>
                      )
                    }

                    // type-translation
                    return (
                      <>
                        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>Type the translation:</p>
                        <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24, direction: isRtl ? 'rtl' : 'ltr', color: 'var(--green-dark)' }}>{pair.word}</p>
                        <form onSubmit={(e) => { e.preventDefault(); handleMixedTypeSubmit() }} style={{ display: 'flex', gap: 10 }}>
                          <input ref={mixedInputRef} type="text" value={mixedInput} onChange={(e) => setMixedInput(e.target.value)}
                            disabled={mixedAnswered} placeholder="Type translation..." autoComplete="off" autoCapitalize="off"
                            style={{ flex: 1 }}
                          />
                          <button type="submit" disabled={mixedAnswered || !mixedInput.trim()}
                            style={{ ...btnGreen, padding: '10px 20px', opacity: mixedAnswered || !mixedInput.trim() ? 0.4 : 1 }}>
                            &crarr;
                          </button>
                        </form>
                      </>
                    )
                  })()}

                  {mixedFeedback === 'correct' && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12, color: 'var(--correct)', fontWeight: 600 }}>
                      {'\u2713'} Correct!
                    </motion.p>
                  )}
                  {mixedFeedback === 'wrong' && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12, color: 'var(--incorrect)' }}>
                      Correct answer: <strong>{mixedCorrectAnswer}</strong>
                    </motion.p>
                  )}
                </Card>
              </AnimatePresence>
            </motion.div>
          )}

          {/* ── RESULTS ─────────────────────────────────────────────── */}
          {stage === 'results' && (
            <motion.div key="results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 640 }}>
              <div style={{ textAlign: 'center', marginBottom: 32 }}>
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                  style={{
                    fontSize: 64, fontWeight: 800,
                    color: mastery >= 80 ? 'var(--green-main)' : mastery >= 50 ? 'var(--yellow)' : 'var(--incorrect)',
                    marginBottom: 8,
                  }}
                >
                  {mastery}%
                </motion.div>
                <p style={{ fontSize: 18, fontWeight: 600, color: 'var(--green-dark)' }}>
                  {mastery >= 80 ? 'Mastered!' : mastery >= 50 ? 'Getting there!' : 'Keep practicing!'}
                </p>
                <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {mixedResults.filter((r) => r.correct).length} / {mixedResults.length} correct in final test
                </p>
              </div>

              {/* Mastery bar */}
              <div style={{ marginBottom: 32, maxWidth: 400, margin: '0 auto 32px' }}>
                <div style={{ height: 8, background: 'var(--surface-alt)', borderRadius: 4, overflow: 'hidden' }}>
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${mastery}%` }}
                    transition={{ duration: 1, ease: 'easeOut' }}
                    style={{
                      height: '100%', borderRadius: 4,
                      background: mastery >= 80 ? 'var(--green-main)' : mastery >= 50 ? 'var(--yellow)' : 'var(--incorrect)',
                    }}
                  />
                </div>
              </div>

              {/* Per-word grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8, marginBottom: 32 }}>
                {[...mixedResults].sort((a, b) => (a.correct === b.correct ? 0 : a.correct ? -1 : 1)).map((r, i) => (
                  <div
                    key={i}
                    style={{
                      background: r.correct ? 'var(--correct-faded)' : 'var(--incorrect-faded)',
                      border: `1px solid ${r.correct ? 'var(--correct)' : 'var(--incorrect)'}`,
                      borderRadius: 'var(--radius)',
                      padding: '10px 14px',
                      fontSize: 14,
                    }}
                  >
                    <div style={{ fontWeight: 600, direction: isRtl ? 'rtl' : 'ltr' }}>{r.word}</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{r.translation}</div>
                    <div style={{ marginTop: 4, fontSize: 16 }}>{r.correct ? '\u2713' : '\u2717'}</div>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
                {mixedResults.some((r) => !r.correct) && (
                  <button onClick={practiceWeak} style={btnPink}>
                    Practice Weak Words
                  </button>
                )}
                <button
                  onClick={() => { setStage('input'); setRawInput(''); setShowConfetti(false) }}
                  style={btnSurface}
                >
                  New List
                </button>
                <button onClick={saveListProgress} style={btnSurface}>
                  Save Progress
                </button>
                <button onClick={exportResults} style={btnSurface}>
                  Export Results
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
