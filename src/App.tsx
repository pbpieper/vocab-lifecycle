import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WordPair {
  word: string
  translation: string
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

type Stage = 'input' | 'see' | 'choose' | 'type' | 'mixed' | 'results'
type MixedFormat = 'mc-word' | 'mc-translation' | 'type-word' | 'type-translation'

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'vocab-lifecycle-lists'
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
  see: { num: 1, label: 'See & Hear', icon: '👁' },
  choose: { num: 2, label: 'Choose', icon: '🎯' },
  type: { num: 3, label: 'Type', icon: '⌨' },
  mixed: { num: 4, label: 'Master', icon: '🏆' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseWords(raw: string): WordPair[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const eqIdx = line.indexOf('=')
      if (eqIdx > 0) {
        return {
          word: line.slice(0, eqIdx).trim(),
          translation: line.slice(eqIdx + 1).trim(),
        }
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
  return levenshtein(a, b) <= 1
}

function speak(text: string, lang: string) {
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
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveLists(lists: SavedList[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lists))
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
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
      color: ['#ffd700', '#22c55e', '#3b82f6', '#ef4444', '#a855f7', '#f97316'][
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
  const stages = ['see', 'choose', 'type', 'mixed'] as const
  const idx = stages.indexOf(current as typeof stages[number])

  return (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'center', padding: '20px 16px 0' }}>
      {stages.map((s, i) => {
        const meta = STAGE_META[s]
        const isActive = i === idx
        const isDone = i < idx
        return (
          <div
            key={s}
            style={{
              flex: 1,
              maxWidth: 200,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <div
              style={{
                height: 4,
                width: '100%',
                borderRadius: 2,
                background: isDone ? 'var(--correct)' : isActive ? 'var(--accent)' : 'var(--border)',
                transition: 'background 0.3s',
              }}
            />
            <span
              style={{
                fontSize: 11,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--accent)' : isDone ? 'var(--correct)' : 'var(--text-muted)',
                transition: 'color 0.3s',
              }}
            >
              {meta.icon} {meta.num}. {meta.label}
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
        borderRadius: 16,
        padding: 32,
        width: '100%',
        maxWidth: 520,
        margin: '0 auto',
        ...style,
      }}
    >
      {children}
    </motion.div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
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

  // ── Stage 1: See
  const [seeIndex, setSeeIndex] = useState(0)

  // ── Stage 2: Choose
  const [chooseIndex, setChooseIndex] = useState(0)
  const [chooseScore, setChooseScore] = useState(0)
  const [, setChooseResults] = useState<StageResult[]>([])
  const [chooseFeedback, setChooseFeedback] = useState<'correct' | 'wrong' | null>(null)
  const [chooseCorrectAnswer, setChooseCorrectAnswer] = useState('')
  const [chooseOptions, setChooseOptions] = useState<string[]>([])
  const [chooseAnswered, setChooseAnswered] = useState(false)

  // ── Stage 3: Type
  const [typeIndex, setTypeIndex] = useState(0)
  const [typeScore, setTypeScore] = useState(0)
  const [, setTypeResults] = useState<StageResult[]>([])
  const [typeFeedback, setTypeFeedback] = useState<'correct' | 'wrong' | null>(null)
  const [typeCorrectAnswer, setTypeCorrectAnswer] = useState('')
  const [typeInput, setTypeInput] = useState('')
  const [typeAnswered, setTypeAnswered] = useState(false)
  const typeInputRef = useRef<HTMLInputElement>(null)

  // ── Stage 4: Mixed
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

  const isRtl = RTL_LANGUAGES.includes(targetLang)

  // ── Generate MC options for choose stage
  const generateChooseOptions = useCallback(
    (idx: number) => {
      const correct = sessionWords[idx].translation
      const others = sessionWords
        .filter((_, i) => i !== idx)
        .map((w) => w.translation)
      const distractors = shuffle(others).slice(0, 3)
      while (distractors.length < 3) {
        distractors.push('—')
      }
      setChooseOptions(shuffle([correct, ...distractors]))
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
        while (distractors.length < 3) distractors.push('—')
        setMixedOptions(shuffle([correct, ...distractors]))
      } else if (format === 'mc-translation') {
        const correct = pair.word
        const others = sessionWords.filter((w) => w.word !== pair.word).map((w) => w.word)
        const distractors = shuffle(others).slice(0, 3)
        while (distractors.length < 3) distractors.push('—')
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

      setSeeIndex(0)
      setChooseIndex(0)
      setChooseScore(0)
      setChooseResults([])
      setChooseFeedback(null)
      setChooseAnswered(false)
      setTypeIndex(0)
      setTypeScore(0)
      setTypeResults([])
      setTypeFeedback(null)
      setTypeInput('')
      setTypeAnswered(false)
      setMixedIndex(0)
      setMixedScore(0)
      setMixedResults([])
      setMixedFeedback(null)
      setMixedInput('')
      setMixedAnswered(false)
      setShowConfetti(false)

      setStage('see')
    },
    [sessionSize],
  )

  // ── Effects: set up options when index changes
  useEffect(() => {
    if (stage === 'choose' && sessionWords.length > 0 && chooseIndex < sessionWords.length) {
      generateChooseOptions(chooseIndex)
      setChooseFeedback(null)
      setChooseAnswered(false)
    }
  }, [stage, chooseIndex, sessionWords, generateChooseOptions])

  useEffect(() => {
    if (stage === 'type' && typeInputRef.current) {
      typeInputRef.current.focus()
    }
  }, [stage, typeIndex])

  useEffect(() => {
    if (stage === 'mixed' && mixedItems.length > 0 && mixedIndex < mixedItems.length) {
      generateMixedOptions(mixedIndex)
      setMixedFeedback(null)
      setMixedInput('')
      setMixedAnswered(false)
      setTimeout(() => {
        if (mixedInputRef.current) mixedInputRef.current.focus()
      }, 100)
    }
  }, [stage, mixedIndex, mixedItems, generateMixedOptions])

  // ── Keyboard handler
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (stage === 'see' && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault()
        if (seeIndex < sessionWords.length - 1) {
          setSeeIndex((i) => i + 1)
        } else {
          setStage('choose')
        }
      }

      if (stage === 'choose' && !chooseAnswered && ['1', '2', '3', '4'].includes(e.key)) {
        const idx = parseInt(e.key) - 1
        if (chooseOptions[idx]) {
          handleChooseAnswer(chooseOptions[idx])
        }
      }

      if (stage === 'mixed' && !mixedAnswered && mixedItems[mixedIndex]) {
        const { format } = mixedItems[mixedIndex]
        if ((format === 'mc-word' || format === 'mc-translation') && ['1', '2', '3', '4'].includes(e.key)) {
          const idx = parseInt(e.key) - 1
          if (mixedOptions[idx]) {
            handleMixedAnswer(mixedOptions[idx])
          }
        }
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, seeIndex, sessionWords, chooseAnswered, chooseOptions, mixedAnswered, mixedItems, mixedIndex, mixedOptions])

  // ── Stage handlers
  function handleChooseAnswer(answer: string) {
    if (chooseAnswered) return
    setChooseAnswered(true)
    const correct = sessionWords[chooseIndex].translation
    const isCorrect = answer === correct
    if (isCorrect) {
      setChooseScore((s) => s + 1)
      setChooseFeedback('correct')
    } else {
      setChooseFeedback('wrong')
      setChooseCorrectAnswer(correct)
    }
    setChooseResults((r) => [
      ...r,
      { word: sessionWords[chooseIndex].word, translation: correct, correct: isCorrect },
    ])
    setTimeout(
      () => {
        if (chooseIndex < sessionWords.length - 1) {
          setChooseIndex((i) => i + 1)
        } else {
          const finalScore = isCorrect ? chooseScore + 1 : chooseScore
          const pct = (finalScore / sessionWords.length) * 100
          if (pct >= 70) {
            setTypeIndex(0)
            setTypeScore(0)
            setTypeResults([])
            setTypeFeedback(null)
            setTypeInput('')
            setTypeAnswered(false)
            setStage('type')
          } else {
            // Repeat
            setChooseIndex(0)
            setChooseScore(0)
            setChooseResults([])
          }
        }
      },
      isCorrect ? 500 : 1500,
    )
  }

  function handleTypeSubmit() {
    if (typeAnswered || !typeInput.trim()) return
    setTypeAnswered(true)
    const correct = sessionWords[typeIndex].word
    const isCorrect = isCloseEnough(typeInput, correct)
    if (isCorrect) {
      setTypeScore((s) => s + 1)
      setTypeFeedback('correct')
    } else {
      setTypeFeedback('wrong')
      setTypeCorrectAnswer(correct)
    }
    setTypeResults((r) => [
      ...r,
      { word: correct, translation: sessionWords[typeIndex].translation, correct: isCorrect },
    ])
    setTimeout(
      () => {
        if (typeIndex < sessionWords.length - 1) {
          setTypeIndex((i) => i + 1)
          setTypeInput('')
          setTypeFeedback(null)
          setTypeAnswered(false)
          setTimeout(() => typeInputRef.current?.focus(), 50)
        } else {
          const finalScore = isCorrect ? typeScore + 1 : typeScore
          const pct = (finalScore / sessionWords.length) * 100
          if (pct >= 60) {
            generateMixedItems()
            setMixedIndex(0)
            setMixedScore(0)
            setMixedResults([])
            setStage('mixed')
          } else {
            setTypeIndex(0)
            setTypeScore(0)
            setTypeResults([])
            setTypeInput('')
            setTypeFeedback(null)
            setTypeAnswered(false)
          }
        }
      },
      isCorrect ? 500 : 1500,
    )
  }

  function handleMixedAnswer(answer: string) {
    if (mixedAnswered) return
    setMixedAnswered(true)
    const { pair, format } = mixedItems[mixedIndex]
    let correct: string
    let isCorrect: boolean

    if (format === 'mc-word') {
      correct = pair.translation
      isCorrect = answer === correct
    } else if (format === 'mc-translation') {
      correct = pair.word
      isCorrect = answer === correct
    } else if (format === 'type-word') {
      correct = pair.word
      isCorrect = isCloseEnough(answer, correct)
    } else {
      correct = pair.translation
      isCorrect = isCloseEnough(answer, correct)
    }

    if (isCorrect) {
      setMixedScore((s) => s + 1)
      setMixedFeedback('correct')
    } else {
      setMixedFeedback('wrong')
      setMixedCorrectAnswer(correct)
    }
    setMixedResults((r) => [...r, { word: pair.word, translation: pair.translation, correct: isCorrect }])

    setTimeout(
      () => {
        if (mixedIndex < mixedItems.length - 1) {
          setMixedIndex((i) => i + 1)
        } else {
          setStage('results')
          const finalScore = isCorrect ? mixedScore + 1 : mixedScore
          if (((finalScore) / mixedItems.length) * 100 >= 80) {
            setShowConfetti(true)
          }
        }
      },
      isCorrect ? 500 : 1500,
    )
  }

  function handleMixedTypeSubmit() {
    if (mixedAnswered || !mixedInput.trim()) return
    handleMixedAnswer(mixedInput)
  }

  function saveProgress() {
    const mastery = mixedResults.length > 0
      ? Math.round((mixedResults.filter((r) => r.correct).length / mixedResults.length) * 100)
      : 0

    const lists = loadLists()
    if (activeListId) {
      const idx = lists.findIndex((l) => l.id === activeListId)
      if (idx >= 0) {
        lists[idx].mastery = mastery
        lists[idx].lastPracticed = Date.now()
      }
    } else {
      lists.push({
        id: uid(),
        name: `${sessionWords[0]?.word || 'List'} +${sessionWords.length - 1}`,
        words: allWords,
        targetLang,
        nativeLang,
        mastery,
        lastPracticed: Date.now(),
      })
    }
    saveLists(lists)
    setSavedLists(lists)
  }

  function practiceWeak() {
    const weakWords = mixedResults.filter((r) => !r.correct).map((r) => ({ word: r.word, translation: r.translation }))
    if (weakWords.length > 0) {
      startSession(weakWords, activeListId ?? undefined)
    }
  }

  // ── Computed
  const parsedWords = useMemo(() => parseWords(rawInput), [rawInput])
  const validWords = parsedWords.filter((w) => w.word)

  const mastery = mixedResults.length > 0
    ? Math.round((mixedResults.filter((r) => r.correct).length / mixedResults.length) * 100)
    : 0

  // ── Styles
  const btnBase: CSSProperties = {
    padding: '12px 24px',
    borderRadius: 10,
    fontWeight: 600,
    fontSize: 15,
    transition: 'all 0.15s',
    cursor: 'pointer',
  }
  const btnGold: CSSProperties = {
    ...btnBase,
    background: 'var(--accent)',
    color: '#0f0f14',
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
              {/* Header */}
              <div style={{ textAlign: 'center', marginBottom: 8 }}>
                <h1 style={{ fontSize: 32, fontWeight: 800, margin: 0, letterSpacing: -0.5 }}>
                  Vocab Lifecycle
                </h1>
                <p style={{ color: 'var(--text-muted)', fontSize: 15, marginTop: 6 }}>
                  From zero to mastery
                </p>
              </div>

              {/* Textarea */}
              <div>
                <textarea
                  value={rawInput}
                  onChange={(e) => setRawInput(e.target.value)}
                  placeholder={"casa = house\nperro = dog\ngato = cat\n\nOr just paste words:\ncasa\nperro\ngato"}
                  style={{
                    width: '100%',
                    minHeight: 180,
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    padding: 16,
                    fontSize: 15,
                    lineHeight: 1.7,
                    color: 'var(--text)',
                    resize: 'vertical',
                  }}
                />
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6, textAlign: 'right' }}>
                  {validWords.length} word{validWords.length !== 1 ? 's' : ''}
                </p>
              </div>

              {/* Language selectors */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
                    These words are in:
                  </label>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      color: 'var(--text)',
                      fontSize: 14,
                    }}
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
                    My native language:
                  </label>
                  <select
                    value={nativeLang}
                    onChange={(e) => setNativeLang(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      color: 'var(--text)',
                      fontSize: 14,
                    }}
                  >
                    <option value="English">English</option>
                    {LANGUAGES.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Session size */}
              <div>
                <label style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, display: 'block' }}>
                  How many words per session?
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
                        background: n === sessionSize ? 'var(--accent-dim)' : 'var(--surface)',
                        border: `1px solid ${n === sessionSize ? 'var(--accent)' : 'var(--border)'}`,
                        color: n === sessionSize ? 'var(--accent)' : 'var(--text-muted)',
                        fontWeight: n === sessionSize ? 700 : 500,
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Begin button */}
              <button
                onClick={() => {
                  if (validWords.length >= 4) {
                    startSession(validWords)
                  }
                }}
                disabled={validWords.length < 4}
                style={{
                  ...btnGold,
                  fontSize: 17,
                  padding: '14px 32px',
                  opacity: validWords.length < 4 ? 0.4 : 1,
                  cursor: validWords.length < 4 ? 'not-allowed' : 'pointer',
                }}
              >
                Begin
              </button>
              {validWords.length > 0 && validWords.length < 4 && (
                <p style={{ fontSize: 13, color: 'var(--wrong)', textAlign: 'center' }}>
                  Add at least 4 words to start
                </p>
              )}

              {/* Saved lists */}
              {savedLists.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>
                    Saved Lists
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {savedLists.map((list) => (
                      <div
                        key={list.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 10,
                          padding: '12px 16px',
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{list.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {list.words.length} words &middot; {list.mastery}% mastery
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => {
                              setTargetLang(list.targetLang)
                              setNativeLang(list.nativeLang)
                              startSession(list.words, list.id)
                            }}
                            style={{ ...btnBase, padding: '6px 14px', fontSize: 13, background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--accent)' }}
                          >
                            Practice
                          </button>
                          <button
                            onClick={() => deleteList(list.id)}
                            style={{ ...btnBase, padding: '6px 10px', fontSize: 13, color: 'var(--text-muted)', border: '1px solid var(--border)' }}
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

          {/* ── STAGE 1: SEE & HEAR ─────────────────────────────────── */}
          {stage === 'see' && sessionWords.length > 0 && (
            <motion.div key="see" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 520 }}>
              {/* Progress dots */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 24 }}>
                {sessionWords.map((_, i) => (
                  <div
                    key={i}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: i <= seeIndex ? 'var(--accent)' : 'var(--border)',
                      transition: 'background 0.2s',
                    }}
                  />
                ))}
              </div>

              <AnimatePresence mode="wait">
                <Card key={seeIndex}>
                  <div
                    onClick={() => {
                      if (seeIndex < sessionWords.length - 1) setSeeIndex((i) => i + 1)
                      else setStage('choose')
                    }}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                  >
                    <p
                      style={{
                        fontSize: 42,
                        fontWeight: 800,
                        marginBottom: 12,
                        direction: isRtl ? 'rtl' : 'ltr',
                      }}
                    >
                      {sessionWords[seeIndex].word}
                    </p>
                    {sessionWords[seeIndex].translation && (
                      <p style={{ fontSize: 20, color: 'var(--text-muted)' }}>
                        {sessionWords[seeIndex].translation}
                      </p>
                    )}
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      speak(sessionWords[seeIndex].word, targetLang)
                    }}
                    style={{
                      ...btnSurface,
                      marginTop: 24,
                      padding: '8px 20px',
                      fontSize: 14,
                    }}
                  >
                    🔊 Listen
                  </button>

                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 20 }}>
                    Tap card or press Space to continue
                  </p>
                </Card>
              </AnimatePresence>

              {seeIndex === sessionWords.length - 1 && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 24, textAlign: 'center' }}>
                  <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 12 }}>
                    You've seen all {sessionWords.length} words. Ready to test yourself?
                  </p>
                  <button onClick={() => setStage('choose')} style={btnGold}>
                    Start Stage 2 &rarr;
                  </button>
                </motion.div>
              )}
            </motion.div>
          )}

          {/* ── STAGE 2: CHOOSE ─────────────────────────────────────── */}
          {stage === 'choose' && sessionWords.length > 0 && (
            <motion.div key="choose" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 520 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {chooseIndex + 1} / {sessionWords.length}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>
                  {chooseScore}/{chooseIndex + (chooseAnswered ? 1 : 0)}
                </span>
              </div>

              <AnimatePresence mode="wait">
                <Card key={chooseIndex}>
                  <p
                    style={{
                      fontSize: 32,
                      fontWeight: 800,
                      marginBottom: 28,
                      direction: isRtl ? 'rtl' : 'ltr',
                    }}
                  >
                    {sessionWords[chooseIndex].word}
                  </p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {chooseOptions.map((opt, i) => {
                      const isCorrect = opt === sessionWords[chooseIndex].translation

                      return (
                        <motion.button
                          key={opt + i}
                          onClick={() => handleChooseAnswer(opt)}
                          disabled={chooseAnswered}
                          animate={
                            chooseAnswered && !isCorrect && chooseFeedback === 'wrong'
                              ? {}
                              : {}
                          }
                          style={{
                            ...btnOption,
                            background: chooseAnswered
                              ? isCorrect
                                ? 'var(--correct-dim)'
                                : 'var(--surface)'
                              : 'var(--surface)',
                            borderColor: chooseAnswered
                              ? isCorrect
                                ? 'var(--correct)'
                                : 'var(--border)'
                              : 'var(--border)',
                            opacity: chooseAnswered && !isCorrect ? 0.5 : 1,
                          }}
                        >
                          <span style={{ color: 'var(--text-muted)', marginRight: 10, fontSize: 13 }}>{i + 1}</span>
                          {opt}
                          {chooseAnswered && isCorrect && (
                            <span style={{ marginLeft: 'auto', color: 'var(--correct)' }}> ✓</span>
                          )}
                        </motion.button>
                      )
                    })}
                  </div>

                  {chooseFeedback === 'wrong' && (
                    <motion.p
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      style={{ marginTop: 16, fontSize: 14, color: 'var(--wrong)' }}
                    >
                      Correct answer: {chooseCorrectAnswer}
                    </motion.p>
                  )}
                </Card>
              </AnimatePresence>
            </motion.div>
          )}

          {/* ── STAGE 3: TYPE ───────────────────────────────────────── */}
          {stage === 'type' && sessionWords.length > 0 && (
            <motion.div key="type" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 520 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {typeIndex + 1} / {sessionWords.length}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>
                  {typeScore}/{typeIndex + (typeAnswered ? 1 : 0)}
                </span>
              </div>

              <AnimatePresence mode="wait">
                <Card key={typeIndex}>
                  <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 8 }}>
                    What is the {targetLang} word for:
                  </p>
                  <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>
                    {sessionWords[typeIndex].translation || sessionWords[typeIndex].word}
                  </p>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      handleTypeSubmit()
                    }}
                    style={{ display: 'flex', gap: 10 }}
                  >
                    <input
                      ref={typeInputRef}
                      type="text"
                      value={typeInput}
                      onChange={(e) => setTypeInput(e.target.value)}
                      disabled={typeAnswered}
                      placeholder={`Type in ${targetLang}...`}
                      autoComplete="off"
                      autoCapitalize="off"
                      style={{
                        flex: 1,
                        padding: '12px 16px',
                        background: 'var(--bg)',
                        border: `2px solid ${
                          typeFeedback === 'correct'
                            ? 'var(--correct)'
                            : typeFeedback === 'wrong'
                            ? 'var(--wrong)'
                            : 'var(--border)'
                        }`,
                        borderRadius: 10,
                        fontSize: 16,
                        color: 'var(--text)',
                        direction: isRtl ? 'rtl' : 'ltr',
                        transition: 'border-color 0.2s',
                      }}
                    />
                    <button
                      type="submit"
                      disabled={typeAnswered || !typeInput.trim()}
                      style={{
                        ...btnGold,
                        padding: '12px 20px',
                        opacity: typeAnswered || !typeInput.trim() ? 0.4 : 1,
                      }}
                    >
                      &crarr;
                    </button>
                  </form>

                  {typeFeedback === 'correct' && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12, color: 'var(--correct)', fontWeight: 600 }}>
                      ✓ Correct!
                    </motion.p>
                  )}
                  {typeFeedback === 'wrong' && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12, color: 'var(--wrong)' }}>
                      Correct answer: <strong>{typeCorrectAnswer}</strong>
                    </motion.p>
                  )}
                </Card>
              </AnimatePresence>
            </motion.div>
          )}

          {/* ── STAGE 4: MIXED ──────────────────────────────────────── */}
          {stage === 'mixed' && mixedItems.length > 0 && mixedIndex < mixedItems.length && (
            <motion.div key="mixed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 520 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {mixedIndex + 1} / {mixedItems.length}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>
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
                          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 8 }}>
                            Choose the translation:
                          </p>
                          <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24, direction: isRtl ? 'rtl' : 'ltr' }}>
                            {pair.word}
                          </p>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {mixedOptions.map((opt, i) => {
                              const isCorrectOpt = opt === pair.translation
                              return (
                                <button
                                  key={opt + i}
                                  onClick={() => handleMixedAnswer(opt)}
                                  disabled={mixedAnswered}
                                  style={{
                                    ...btnOption,
                                    background: mixedAnswered
                                      ? isCorrectOpt ? 'var(--correct-dim)' : 'var(--surface)'
                                      : 'var(--surface)',
                                    borderColor: mixedAnswered
                                      ? isCorrectOpt ? 'var(--correct)' : 'var(--border)'
                                      : 'var(--border)',
                                    opacity: mixedAnswered && !isCorrectOpt ? 0.5 : 1,
                                  }}
                                >
                                  <span style={{ color: 'var(--text-muted)', marginRight: 10, fontSize: 13 }}>{i + 1}</span>
                                  {opt}
                                  {mixedAnswered && isCorrectOpt && <span style={{ marginLeft: 'auto', color: 'var(--correct)' }}> ✓</span>}
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
                          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 8 }}>
                            Choose the {targetLang} word:
                          </p>
                          <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>
                            {pair.translation}
                          </p>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {mixedOptions.map((opt, i) => {
                              const isCorrectOpt = opt === pair.word
                              return (
                                <button
                                  key={opt + i}
                                  onClick={() => handleMixedAnswer(opt)}
                                  disabled={mixedAnswered}
                                  style={{
                                    ...btnOption,
                                    background: mixedAnswered
                                      ? isCorrectOpt ? 'var(--correct-dim)' : 'var(--surface)'
                                      : 'var(--surface)',
                                    borderColor: mixedAnswered
                                      ? isCorrectOpt ? 'var(--correct)' : 'var(--border)'
                                      : 'var(--border)',
                                    opacity: mixedAnswered && !isCorrectOpt ? 0.5 : 1,
                                    direction: isRtl ? 'rtl' : 'ltr',
                                  }}
                                >
                                  <span style={{ color: 'var(--text-muted)', marginRight: 10, fontSize: 13 }}>{i + 1}</span>
                                  {opt}
                                  {mixedAnswered && isCorrectOpt && <span style={{ marginLeft: 'auto', color: 'var(--correct)' }}> ✓</span>}
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
                          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 8 }}>
                            Type the {targetLang} word for:
                          </p>
                          <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>
                            {pair.translation}
                          </p>
                          <form onSubmit={(e) => { e.preventDefault(); handleMixedTypeSubmit() }} style={{ display: 'flex', gap: 10 }}>
                            <input
                              ref={mixedInputRef}
                              type="text"
                              value={mixedInput}
                              onChange={(e) => setMixedInput(e.target.value)}
                              disabled={mixedAnswered}
                              placeholder={`Type in ${targetLang}...`}
                              autoComplete="off"
                              autoCapitalize="off"
                              style={{
                                flex: 1,
                                padding: '12px 16px',
                                background: 'var(--bg)',
                                border: `2px solid ${
                                  mixedFeedback === 'correct' ? 'var(--correct)'
                                    : mixedFeedback === 'wrong' ? 'var(--wrong)'
                                    : 'var(--border)'
                                }`,
                                borderRadius: 10,
                                fontSize: 16,
                                color: 'var(--text)',
                                direction: isRtl ? 'rtl' : 'ltr',
                                transition: 'border-color 0.2s',
                              }}
                            />
                            <button type="submit" disabled={mixedAnswered || !mixedInput.trim()} style={{ ...btnGold, padding: '12px 20px', opacity: mixedAnswered || !mixedInput.trim() ? 0.4 : 1 }}>
                              &crarr;
                            </button>
                          </form>
                        </>
                      )
                    }

                    // type-translation
                    return (
                      <>
                        <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 8 }}>
                          Type the translation:
                        </p>
                        <p style={{ fontSize: 28, fontWeight: 700, marginBottom: 24, direction: isRtl ? 'rtl' : 'ltr' }}>
                          {pair.word}
                        </p>
                        <form onSubmit={(e) => { e.preventDefault(); handleMixedTypeSubmit() }} style={{ display: 'flex', gap: 10 }}>
                          <input
                            ref={mixedInputRef}
                            type="text"
                            value={mixedInput}
                            onChange={(e) => setMixedInput(e.target.value)}
                            disabled={mixedAnswered}
                            placeholder="Type translation..."
                            autoComplete="off"
                            autoCapitalize="off"
                            style={{
                              flex: 1,
                              padding: '12px 16px',
                              background: 'var(--bg)',
                              border: `2px solid ${
                                mixedFeedback === 'correct' ? 'var(--correct)'
                                  : mixedFeedback === 'wrong' ? 'var(--wrong)'
                                  : 'var(--border)'
                              }`,
                              borderRadius: 10,
                              fontSize: 16,
                              color: 'var(--text)',
                              transition: 'border-color 0.2s',
                            }}
                          />
                          <button type="submit" disabled={mixedAnswered || !mixedInput.trim()} style={{ ...btnGold, padding: '12px 20px', opacity: mixedAnswered || !mixedInput.trim() ? 0.4 : 1 }}>
                            &crarr;
                          </button>
                        </form>
                      </>
                    )
                  })()}

                  {mixedFeedback === 'correct' && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12, color: 'var(--correct)', fontWeight: 600 }}>
                      ✓ Correct!
                    </motion.p>
                  )}
                  {mixedFeedback === 'wrong' && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12, color: 'var(--wrong)' }}>
                      Correct answer: <strong>{mixedCorrectAnswer}</strong>
                    </motion.p>
                  )}
                </Card>
              </AnimatePresence>
            </motion.div>
          )}

          {/* ── RESULTS ─────────────────────────────────────────────── */}
          {stage === 'results' && (
            <motion.div key="results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 600 }}>
              <div style={{ textAlign: 'center', marginBottom: 32 }}>
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                  style={{
                    fontSize: 64,
                    fontWeight: 800,
                    color: mastery >= 80 ? 'var(--correct)' : mastery >= 50 ? 'var(--accent)' : 'var(--wrong)',
                    marginBottom: 8,
                  }}
                >
                  {mastery}%
                </motion.div>
                <p style={{ fontSize: 18, fontWeight: 600 }}>
                  {mastery >= 80 ? 'Mastered!' : mastery >= 50 ? 'Getting there!' : 'Keep practicing!'}
                </p>
                <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 4 }}>
                  {mixedResults.filter((r) => r.correct).length} / {mixedResults.length} correct in final test
                </p>
              </div>

              {/* Per-word grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                  gap: 8,
                  marginBottom: 32,
                }}
              >
                {mixedResults.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      background: r.correct ? 'var(--correct-dim)' : 'var(--wrong-dim)',
                      border: `1px solid ${r.correct ? 'var(--correct)' : 'var(--wrong)'}`,
                      borderRadius: 10,
                      padding: '10px 14px',
                      fontSize: 14,
                    }}
                  >
                    <div style={{ fontWeight: 600, direction: isRtl ? 'rtl' : 'ltr' }}>{r.word}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{r.translation}</div>
                    <div style={{ marginTop: 4, fontSize: 16 }}>{r.correct ? '✓' : '✗'}</div>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
                {mixedResults.some((r) => !r.correct) && (
                  <button onClick={practiceWeak} style={btnGold}>
                    Practice weak words
                  </button>
                )}
                <button
                  onClick={() => {
                    setStage('input')
                    setRawInput('')
                    setShowConfetti(false)
                  }}
                  style={btnSurface}
                >
                  New list
                </button>
                <button onClick={saveProgress} style={btnSurface}>
                  Save progress
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
