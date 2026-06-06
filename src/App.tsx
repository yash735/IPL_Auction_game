import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import './styles.css'
import { AUCTION_CONFIG, FRANCHISE_MAP, FRANCHISES } from './lib/config'
import {
  addPlayerToTeam,
  botWillingness,
  canBid,
  createFranchises,
  efficiency,
  formatPrice,
  getIncrement,
  getSquadMax,
  humanDiscount,
  jumpBid,
  teamStrength,
  validateSquad,
} from './lib/auction'
import type { AuctionState, FranchiseId, FranchiseState, PlayerRecord } from './lib/types'
import { SAMPLE_PLAYERS } from './data/sampleAuctionPool'

const sortedTeams = [...FRANCHISES]

type GameState = {
  humanSeats: number
  selectedFranchises: FranchiseId[]
  activeFranchiseId: FranchiseId
  franchises: Record<FranchiseId, FranchiseState>
  auction: AuctionState & { recentResult?: AuctionResultFlash }
}

type AuctionResultFlash = {
  id: string
  kind: 'sold' | 'unsold'
  playerId: string
  playerName: string
  line: string
  teamId?: FranchiseId
  teamName?: string
  amount?: number
  accent: string
}

function initialAuction(players: PlayerRecord[]): AuctionState {
  return {
    pool: players,
    queue: [],
    currentIndex: 0,
    currentBid: 0,
    phase: 'setup',
    timer: 0,
    auctioneerLine: 'Welcome to the auction hall.',
    log: ['Pick human franchises and start the auction.'],
    unsold: [],
    acceleratedRound: false,
  }
}

function initialGame(players: PlayerRecord[]): GameState {
  const selectedFranchises: FranchiseId[] = ['CSK']
  return {
    humanSeats: 1,
    selectedFranchises,
    activeFranchiseId: selectedFranchises[0],
    franchises: createFranchises(selectedFranchises),
    auction: initialAuction(players),
  }
}

function roleCounts(team: FranchiseState) {
  return team.squad.reduce(
    (counts, player) => {
      counts[player.role] += 1
      return counts
    },
    {
      Batter: 0,
      Bowler: 0,
      'All-rounder': 0,
      Wicketkeeper: 0,
    } as Record<'Batter' | 'Bowler' | 'All-rounder' | 'Wicketkeeper', number>,
  )
}

function squadPreview(team: FranchiseState) {
  return team.squad.slice().sort((a, b) => b.soldFor - a.soldFor || b.form - a.form)
}

function queuePreviewLabel(player: PlayerRecord) {
  return `${player.role} · ${formatPrice(player.basePrice)} · ${player.isOverseas ? 'Overseas' : 'Indian'}`
}

function shuffle<T>(items: T[]) {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function timerForPlayer(selectedFranchises: FranchiseId[]) {
  return selectedFranchises.includes('CSK') ? Math.round(AUCTION_CONFIG.bidTimerSeconds * 1.2) : AUCTION_CONFIG.bidTimerSeconds
}

function saleDiscount(team: FranchiseState, player: PlayerRecord, hammerPrice: number) {
  let price = hammerPrice
  if (team.id === 'RCB' && player.role === 'Batter' && team.squad.filter((p) => p.role === 'Batter').length < 2) price *= 0.9
  if (team.id === 'KKR' && player.role === 'Bowler') price *= 0.9
  if (team.id === 'DC' && !player.isCapped) price *= 0.85
  if (team.id === 'GT' && player.previousTeam && player.previousTeam !== team.id) price *= 0.95
  return Number(price.toFixed(2))
}

function App() {
  const [fetchStatus, setFetchStatus] = useState<'loading' | 'done' | 'error'>('loading')
  const [game, setGame] = useState<GameState>(() => initialGame([...SAMPLE_PLAYERS].sort((a, b) => b.form - a.form)))
  const [auctionResult, setAuctionResult] = useState<AuctionResultFlash | null>(null)
  const auctionAudioRef = useRef<AudioContext | null>(null)
  const players = game.auction.pool

  useEffect(() => {
    const controller = new AbortController()
    fetch('/data/auction_pool.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('fetch failed')
        return res.json() as Promise<PlayerRecord[]>
      })
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const sorted = [...data].sort((a, b) => b.form - a.form)
          setGame((prev) =>
            prev.auction.phase === 'setup'
              ? { ...prev, auction: { ...prev.auction, pool: sorted } }
              : prev
          )
        }
        setFetchStatus('done')
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') setFetchStatus('error')
      })
    return () => controller.abort()
  }, [])

  const currentPlayer = game.auction.queue[game.auction.currentIndex]
  const teams = Object.values(game.franchises)
  const humanTeams = teams.filter((team) => team.isHuman)
  const botTeams = teams.filter((team) => !team.isHuman)
  const activeFranchise = game.franchises[game.activeFranchiseId] ?? humanTeams[0] ?? teams[0]
  const previewPlayers = useMemo(() => {
    const extra = game.selectedFranchises.includes('RR') ? 1 : 0
    return game.auction.queue.slice(game.auction.currentIndex, game.auction.currentIndex + 4 + extra)
  }, [game.auction.currentIndex, game.auction.queue, game.selectedFranchises])

  useEffect(() => {
    if (!auctionResult) return
    const timeout = window.setTimeout(() => setAuctionResult(null), 2400)
    return () => window.clearTimeout(timeout)
  }, [auctionResult])

  useEffect(() => {
    if (!game.auction.recentResult) return
    fireAuctionResult(game.auction.recentResult)
  }, [game.auction.recentResult?.id])

  function primeAuctionAudio() {
    if (typeof window === 'undefined') return
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    if (!auctionAudioRef.current) {
      auctionAudioRef.current = new AudioCtx()
    }
    if (auctionAudioRef.current.state === 'suspended') {
      void auctionAudioRef.current.resume()
    }
  }

  function playResultSound(kind: AuctionResultFlash['kind']) {
    primeAuctionAudio()
    const ctx = auctionAudioRef.current
    if (!ctx) return

    const start = ctx.currentTime + 0.02
    const master = ctx.createGain()
    master.gain.setValueAtTime(0.0001, start)
    master.gain.exponentialRampToValueAtTime(kind === 'sold' ? 0.35 : 0.22, start + 0.015)
    master.gain.exponentialRampToValueAtTime(0.0001, start + (kind === 'sold' ? 0.34 : 0.24))
    master.connect(ctx.destination)

    const makeStrike = (time: number, freqStart: number, freqEnd: number, duration: number, volume: number) => {
      const osc = ctx.createOscillator()
      const filter = ctx.createBiquadFilter()
      const gain = ctx.createGain()

      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(2200, time)
      filter.frequency.exponentialRampToValueAtTime(900, time + duration)

      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freqStart, time)
      osc.frequency.exponentialRampToValueAtTime(freqEnd, time + duration)

      gain.gain.setValueAtTime(0.0001, time)
      gain.gain.exponentialRampToValueAtTime(volume, time + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration)

      osc.connect(filter)
      filter.connect(gain)
      gain.connect(master)
      osc.start(time)
      osc.stop(time + duration + 0.05)
    }

    if (kind === 'sold') {
      makeStrike(start, 220, 86, 0.16, 0.52)
      makeStrike(start + 0.07, 160, 64, 0.13, 0.34)
      makeStrike(start + 0.14, 118, 56, 0.11, 0.22)
    } else {
      makeStrike(start, 150, 64, 0.18, 0.28)
    }
  }

  function fireAuctionResult(result: Omit<AuctionResultFlash, 'id'>) {
    setAuctionResult({
      ...result,
      id: `${result.playerId}-${result.kind}-${result.teamId ?? 'none'}-${result.amount ?? 0}`,
    })
    playResultSound(result.kind)
  }

  function withRecentResult(gameState: GameState, result: Omit<AuctionResultFlash, 'id'>): GameState {
    return {
      ...gameState,
      auction: {
        ...gameState.auction,
        recentResult: {
          ...result,
          id: `${result.playerId}-${gameState.auction.currentIndex}-${result.kind}`,
        },
      },
    }
  }

  useEffect(() => {
    if (game.auction.phase !== 'auction' || !currentPlayer) return
    if (game.auction.timer <= 0) return

    const tick = window.setInterval(() => {
      setGame((prev: GameState) => {
        if (prev.auction.phase !== 'auction') return prev
        const nextTimer = prev.auction.timer - 1
        if (nextTimer <= 0) return settleCurrent(prev)
        const auctioneerLine = nextTimer <= 3 ? 'Going once…' : nextTimer <= 6 ? 'Going twice…' : prev.auction.auctioneerLine
        return { ...prev, auction: { ...prev.auction, timer: nextTimer, auctioneerLine } }
      })
    }, 1000)

    return () => window.clearInterval(tick)
  }, [game.auction.phase, game.auction.timer, currentPlayer])

  useEffect(() => {
    if (game.auction.phase !== 'auction' || !currentPlayer) return

    const pulse = window.setInterval(() => {
      setGame((prev: GameState) => maybeBotBid(prev))
    }, 1100)

    return () => window.clearInterval(pulse)
  }, [game.auction.phase, currentPlayer])

  function startAuction() {
    primeAuctionAudio()
    setAuctionResult(null)
    const picked: FranchiseId[] = game.selectedFranchises.length ? game.selectedFranchises : ['CSK']
    const shuffled = shuffle(players)
    const first = shuffled[0]
    setGame((prev: GameState) => ({
      ...prev,
      selectedFranchises: picked,
      activeFranchiseId: picked[0],
      franchises: createFranchises(picked),
      auction: {
        pool: shuffled,
        queue: shuffled,
        currentIndex: 0,
        currentBid: first?.basePrice ?? 0,
        currentPlayer: first,
        phase: 'auction',
        timer: first ? timerForPlayer(picked) : 0,
        auctioneerLine: first ? `${first.name} is up on the big screen.` : 'No players in the pool.',
        log: [`Auction started with ${shuffled.length} players.`],
        unsold: [],
        acceleratedRound: false,
      },
    }))
  }

  function resetLobby() {
    setAuctionResult(null)
    setGame(initialGame(players))
  }

  function ensureHumanSeats(nextSeats: number) {
    setGame((prev: GameState) => {
      const selected = prev.selectedFranchises.slice(0, nextSeats) as FranchiseId[]
      const activeFranchiseId = selected[0] ?? prev.activeFranchiseId
      return {
        ...prev,
        humanSeats: nextSeats,
        selectedFranchises: selected,
        activeFranchiseId,
        franchises: prev.auction.phase === 'setup' ? createFranchises(selected) : prev.franchises,
      }
    })
  }

  function toggleFranchise(id: FranchiseId) {
    setGame((prev: GameState) => {
      const exists = prev.selectedFranchises.includes(id)
      if (exists) {
        const selected = prev.selectedFranchises.filter((team) => team !== id) as FranchiseId[]
        const activeFranchiseId = prev.activeFranchiseId === id ? selected[0] ?? id : prev.activeFranchiseId
        return {
          ...prev,
          selectedFranchises: selected,
          activeFranchiseId,
          franchises: prev.auction.phase === 'setup' ? createFranchises(selected) : prev.franchises,
        }
      }
      if (prev.selectedFranchises.length >= prev.humanSeats) return prev
      const selected = [...prev.selectedFranchises, id] as FranchiseId[]
      return {
        ...prev,
        selectedFranchises: selected,
        activeFranchiseId: id,
        franchises: prev.auction.phase === 'setup' ? createFranchises(selected) : prev.franchises,
      }
    })
  }

  function setActiveFranchise(id: FranchiseId) {
    setGame((prev: GameState) => ({ ...prev, activeFranchiseId: id }))
  }

  function placeHumanBid(teamId: FranchiseId, jump = false) {
    primeAuctionAudio()
    setGame((prev: GameState) => bid(prev, teamId, jump))
  }

  function projectedHumanBid(team: FranchiseState, player: PlayerRecord, currentBid: number, jump = false) {
    const candidateBid = jump ? currentBid + getIncrement(currentBid) * 2 : currentBid + getIncrement(currentBid)
    return Number(humanDiscount(team, player, candidateBid).toFixed(2))
  }

  function bid(gameState: GameState, teamId: FranchiseId, jump = false): GameState {
    if (gameState.auction.phase !== 'auction' || !gameState.auction.currentPlayer) return gameState
    const team = gameState.franchises[teamId]
    const player = gameState.auction.currentPlayer
    const currentBid = gameState.auction.currentBid || player.basePrice
    const isJump = jump && team.id === 'PBKS' && !team.jumpBidUsed
    const candidateBid = isJump ? jumpBid({ ...team, jumpBidUsed: false }, currentBid) : currentBid + getIncrement(currentBid)
    const effectiveBid = Number(humanDiscount(team, player, candidateBid).toFixed(2))
    if (!canBid(team, player, effectiveBid)) return gameState
    if (gameState.auction.highBidder === teamId && !isJump) return gameState

    const updatedFranchises = isJump
      ? { ...gameState.franchises, [teamId]: { ...team, jumpBidUsed: true } }
      : gameState.franchises

    return {
      ...gameState,
      franchises: updatedFranchises,
      auction: {
        ...gameState.auction,
        currentBid: effectiveBid,
        highBidder: teamId,
        highBidderName: team.name,
        timer: timerForPlayer(gameState.selectedFranchises),
        auctioneerLine: `${team.name} leads on ${player.name}.`,
        log: [...gameState.auction.log, `${team.name} bids ${formatPrice(effectiveBid)}${isJump ? ' (jump)' : ''}`],
      },
    }
  }

  function maybeBotBid(gameState: GameState): GameState {
    if (gameState.auction.phase !== 'auction' || !gameState.auction.currentPlayer) return gameState
    if (gameState.auction.rtmPending) return gameState
    const player = gameState.auction.currentPlayer
    const currentBid = gameState.auction.currentBid || player.basePrice
    const increment = getIncrement(currentBid)
    const nextBid = currentBid + increment
    const queueSize = gameState.auction.queue.length - gameState.auction.currentIndex

    // Use live franchise state; exclude current high bidder so bots don't outbid themselves
    const liveBots = Object.values(gameState.franchises).filter(
      (t) => !t.isHuman && t.id !== gameState.auction.highBidder,
    )

    const best = liveBots
      .map((team) => {
        const baseWillingness = botWillingness(team, player, queueSize)
        const isJumpCandidate = team.id === 'PBKS' && !team.jumpBidUsed && baseWillingness >= currentBid + increment * 2
        const candidateBid = isJumpCandidate ? currentBid + increment * 2 : nextBid
        const effectiveBid = Number(humanDiscount(team, player, candidateBid).toFixed(2))
        const jitteredWillingness = baseWillingness * (0.93 + Math.random() * 0.14)
        return {
          team,
          baseWillingness,
          isJumpCandidate,
          candidateBid,
          effectiveBid,
          jitteredWillingness,
        }
      })
      .filter(({ team, baseWillingness, effectiveBid }) => baseWillingness >= nextBid && canBid(team, player, effectiveBid))
      .sort((a, b) => b.jitteredWillingness - a.jitteredWillingness)[0]

    if (!best) return gameState

    const isJump = best.isJumpCandidate
    const candidateBid = best.candidateBid
    const effectiveBid = best.effectiveBid
    if (!canBid(best.team, player, effectiveBid)) return gameState

    const updatedFranchises = isJump
      ? { ...gameState.franchises, [best.team.id]: { ...best.team, jumpBidUsed: true } }
      : gameState.franchises

    return {
      ...gameState,
      franchises: updatedFranchises,
      auction: {
        ...gameState.auction,
        currentBid: effectiveBid,
        highBidder: best.team.id,
        highBidderName: best.team.name,
        timer: Math.max(gameState.auction.timer, 3),
        auctioneerLine: `${best.team.name} raises the paddle.`,
        log: [...gameState.auction.log, `${best.team.name} bids ${formatPrice(effectiveBid)}${isJump ? ' (jump)' : ''}`],
      },
    }
  }

  function settleCurrent(gameState: GameState): GameState {
    const player = gameState.auction.currentPlayer
    if (!player) return finishAuction(gameState)
    if (gameState.auction.rtmPending) return gameState

    if (!gameState.auction.highBidder) {
      return advanceAfterSettle(
        withRecentResult({
          ...gameState,
          auction: {
            ...gameState.auction,
            unsold: [...gameState.auction.unsold, player],
            log: [...gameState.auction.log, `${player.name} goes UNSOLD.`],
            auctioneerLine: `${player.name} is left for the accelerated round.`,
          },
        }, {
          kind: 'unsold',
          playerId: player.id,
          playerName: player.name,
          line: `${player.name} goes UNSOLD.`,
          accent: '#60a5fa',
        })
      )
    }

    const winner = gameState.auction.highBidder
    const hammer = gameState.auction.currentBid
    const previousTeamId = player.previousTeam

    if (previousTeamId && previousTeamId !== winner) {
      const previousTeam = gameState.franchises[previousTeamId]
      if (previousTeam && previousTeam.rtmRemaining > 0 && canBid(previousTeam, player, hammer)) {
        if (previousTeam.isHuman) {
          // Pause auction and wait for human RTM decision
          return {
            ...gameState,
            auction: {
              ...gameState.auction,
              rtmPending: { player, winner, finalBid: hammer, previousTeam: previousTeamId },
              timer: 0,
              auctioneerLine: `${previousTeam.name}: use RTM to match ${formatPrice(hammer)} for ${player.name}?`,
              log: [...gameState.auction.log, `RTM: ${previousTeam.name} can match ${formatPrice(hammer)} for ${player.name}.`],
            },
          }
        }
        // Bot RTM: only use if willing
        const queueSize = gameState.auction.queue.length - gameState.auction.currentIndex
        if (botWillingness(previousTeam, player, queueSize) >= hammer) {
          const updatedPrevious = { ...previousTeam, rtmRemaining: previousTeam.rtmRemaining - 1 }
          const sale = saleDiscount(updatedPrevious, player, hammer)
          const updatedFranchises = {
            ...gameState.franchises,
            [previousTeamId]: addPlayerToTeam(updatedPrevious, player, sale),
          }
          return advanceAfterSettle(
            withRecentResult({
              ...gameState,
              franchises: updatedFranchises,
              auction: {
                ...gameState.auction,
                log: [...gameState.auction.log, `${previousTeam.name} uses RTM and matches ${formatPrice(hammer)}.`],
                auctioneerLine: `${previousTeam.name} snatches ${player.name} back.`,
              },
            }, {
              kind: 'sold',
              playerId: player.id,
              playerName: player.name,
              teamId: previousTeamId,
              teamName: previousTeam.name,
              amount: sale,
              line: `${player.name} SOLD to ${previousTeam.name} via RTM for ${formatPrice(sale)}.`,
              accent: previousTeam.color,
            })
          )
        }
      }
    }

    const winningTeam = gameState.franchises[winner]
    const sale = saleDiscount(winningTeam, player, hammer)
    const updatedFranchises = {
      ...gameState.franchises,
      [winner]: addPlayerToTeam(winningTeam, player, sale),
    }

    return advanceAfterSettle(
      withRecentResult({
        ...gameState,
        franchises: updatedFranchises,
        auction: {
          ...gameState.auction,
          log: [...gameState.auction.log, `${player.name} SOLD to ${winningTeam.name} for ${formatPrice(sale)}`],
          auctioneerLine: `${player.name} SOLD to ${winningTeam.name}.`,
        },
      }, {
        kind: 'sold',
        playerId: player.id,
        playerName: player.name,
        teamId: winner,
        teamName: winningTeam.name,
        amount: sale,
        line: `${player.name} SOLD to ${winningTeam.name} for ${formatPrice(sale)}.`,
        accent: winningTeam.color,
      })
    )
  }

  function advanceAfterSettle(gameState: GameState): GameState {
    const nextIndex = gameState.auction.currentIndex + 1
    if (nextIndex < gameState.auction.queue.length) {
      const nextPlayer = gameState.auction.queue[nextIndex]
      return {
        ...gameState,
        auction: {
          ...gameState.auction,
          rtmPending: undefined,
          currentIndex: nextIndex,
          currentPlayer: nextPlayer,
          currentBid: nextPlayer.basePrice,
          highBidder: undefined,
          highBidderName: undefined,
          timer: gameState.auction.acceleratedRound
            ? AUCTION_CONFIG.acceleratedTimerSeconds
            : timerForPlayer(gameState.selectedFranchises),
          auctioneerLine: gameState.auction.acceleratedRound
            ? `Accelerated: ${nextPlayer.name} back on the block.`
            : `${nextPlayer.name} takes centre stage.`,
        },
      }
    }

    if (gameState.auction.unsold.length > 0 && !gameState.auction.acceleratedRound) {
      const queue = gameState.auction.unsold
      const nextPlayer = queue[0]
      return {
        ...gameState,
        auction: {
          ...gameState.auction,
          rtmPending: undefined,
          queue,
          unsold: [],
          currentIndex: 0,
          currentPlayer: nextPlayer,
          currentBid: nextPlayer.basePrice,
          highBidder: undefined,
          highBidderName: undefined,
          timer: AUCTION_CONFIG.acceleratedTimerSeconds,
          acceleratedRound: true,
          auctioneerLine: `Accelerated round — ${nextPlayer.name} leads off.`,
          log: [...gameState.auction.log, `Accelerated round: ${queue.length} unsold player${queue.length > 1 ? 's' : ''} return.`],
        },
      }
    }

    return finishAuction({
      ...gameState,
      auction: {
        ...gameState.auction,
        phase: 'finished',
        currentPlayer: undefined,
        timer: 0,
        auctioneerLine: 'Auction complete.',
      },
    })
  }

  function useRtm() {
    primeAuctionAudio()
    setGame((prev: GameState) => {
      const rtm = prev.auction.rtmPending
      if (!rtm) return prev
      const previousTeam = prev.franchises[rtm.previousTeam]
      const updatedPrevious = { ...previousTeam, rtmRemaining: previousTeam.rtmRemaining - 1 }
      const sale = saleDiscount(updatedPrevious, rtm.player, rtm.finalBid)
      return advanceAfterSettle(
        withRecentResult({
          ...prev,
          franchises: { ...prev.franchises, [rtm.previousTeam]: addPlayerToTeam(updatedPrevious, rtm.player, sale) },
          auction: {
            ...prev.auction,
            rtmPending: undefined,
            log: [...prev.auction.log, `${previousTeam.name} uses RTM — ${rtm.player.name} matched at ${formatPrice(rtm.finalBid)}.`],
            auctioneerLine: `${previousTeam.name} snatches ${rtm.player.name} back.`,
          },
        }, {
          kind: 'sold',
          playerId: rtm.player.id,
          playerName: rtm.player.name,
          teamId: rtm.previousTeam,
          teamName: previousTeam.name,
          amount: sale,
          line: `${rtm.player.name} SOLD to ${previousTeam.name} via RTM for ${formatPrice(sale)}.`,
          accent: previousTeam.color,
        })
      )
    })
  }

  function passRtm() {
    primeAuctionAudio()
    setGame((prev: GameState) => {
      const rtm = prev.auction.rtmPending
      if (!rtm) return prev
      const winningTeam = prev.franchises[rtm.winner]
      const sale = saleDiscount(winningTeam, rtm.player, rtm.finalBid)
      return advanceAfterSettle(
        withRecentResult({
          ...prev,
          franchises: { ...prev.franchises, [rtm.winner]: addPlayerToTeam(winningTeam, rtm.player, sale) },
          auction: {
            ...prev.auction,
            rtmPending: undefined,
            log: [...prev.auction.log, `${FRANCHISE_MAP[rtm.previousTeam].name} passes RTM. ${rtm.player.name} SOLD to ${winningTeam.name}.`],
            auctioneerLine: `${rtm.player.name} SOLD to ${winningTeam.name}.`,
          },
        }, {
          kind: 'sold',
          playerId: rtm.player.id,
          playerName: rtm.player.name,
          teamId: rtm.winner,
          teamName: winningTeam.name,
          amount: sale,
          line: `${rtm.player.name} SOLD to ${winningTeam.name} for ${formatPrice(sale)}.`,
          accent: winningTeam.color,
        })
      )
    })
  }

  function finishAuction(gameState: GameState): GameState {
    const scored = Object.values(gameState.franchises)
      .map((team) => ({ team, strength: teamStrength(team), eff: efficiency(team), validation: validateSquad(team) }))
      .sort((a, b) => b.strength - a.strength)
    const winner = scored[0]?.team.id
    const invalidCount = scored.filter(({ validation }) => !validation.valid).length
    return {
      ...gameState,
      auction: {
        ...gameState.auction,
        phase: 'finished',
        winner,
        currentPlayer: undefined,
        auctioneerLine: winner ? `${FRANCHISE_MAP[winner].name} tops the board.` : 'Auction complete.',
        log: [
          ...gameState.auction.log,
          winner ? `Winner: ${FRANCHISE_MAP[winner].name}` : 'Auction complete.',
          invalidCount ? `${invalidCount} squad${invalidCount > 1 ? 's' : ''} need attention.` : 'All squads are valid.',
        ],
      },
    }
  }

  const leaderboard = useMemo(() => {
    return Object.values(game.franchises)
      .map((team) => ({ team, strength: teamStrength(team), eff: efficiency(team), validation: validateSquad(team) }))
      .sort((a, b) => b.strength - a.strength)
  }, [game.franchises])

  const activeTeamCounts = activeFranchise ? roleCounts(activeFranchise) : null
  const activeTeamSquad = activeFranchise ? squadPreview(activeFranchise) : []
  const rrPreviewSlots = game.selectedFranchises.includes('RR') ? 1 : 0
  const queueSpotlight = previewPlayers[0]
  const resultSweepStyle = auctionResult
    ? ({
        '--result-accent': auctionResult.accent,
        '--result-accent-soft': `${auctionResult.accent}44`,
      } as CSSProperties)
    : undefined
  const auctioneerLine = auctionResult?.line ?? game.auction.auctioneerLine

  return (
    <div className="app-shell">

      <header className="topbar">
        <div>
          <div className="eyebrow">IPL auction hall</div>
          <h1>Player Auction Game</h1>
        </div>
        <div className="topbar-stats">
          <span>{game.humanSeats} human seat{game.humanSeats > 1 ? 's' : ''}</span>
          <span>{game.auction.queue.length || players.length} players</span>
          <span>{game.auction.phase === 'finished' ? 'Auction closed' : game.auction.phase === 'auction' ? 'Live bidding' : 'Lobby'}</span>
          {fetchStatus === 'loading' && <span className="fetch-badge">Loading pool…</span>}
          {fetchStatus === 'error' && <span className="fetch-badge fetch-badge--error">Sample data (fetch failed)</span>}
        </div>
      </header>

      {game.auction.phase === 'setup' ? (
        <section className="lobby-grid">
          <div className="panel hero-panel">
            <div className="hero-copy">
              <div className="eyebrow">Build the table</div>
              <h2>Pick 1–10 human franchises, then let the bots fill the rest.</h2>
              <p>Local hot-seat is fine. Every human seat controls one franchise, and the CPU tables feel a bit like actual owners, not dice rolls.</p>
            </div>
            <div className="lobby-controls">
              <label>
                Human seats
                <div className="stepper">
                  <button onClick={() => ensureHumanSeats(Math.max(1, game.humanSeats - 1))}>−</button>
                  <strong>{game.humanSeats}</strong>
                  <button onClick={() => ensureHumanSeats(Math.min(10, game.humanSeats + 1))}>+</button>
                </div>
              </label>
              <div className="selected-strip">
                {game.selectedFranchises.map((team) => (
                  <span key={team} className="pill active">{team}</span>
                ))}
                {Array.from({ length: Math.max(0, game.humanSeats - game.selectedFranchises.length) }).map((_, index) => (
                  <span key={index} className="pill empty">pick seat</span>
                ))}
              </div>
              <button className="primary" disabled={game.selectedFranchises.length !== game.humanSeats} onClick={startAuction}>Start auction</button>
              <button className="ghost" onClick={resetLobby}>Reset lobby</button>

              <div className="rules-card">
                <div className="panel-title">Official auction rules</div>
                <ul>
                  <li>Purse: <strong>₹120 crore</strong> per franchise.</li>
                  <li>Squad: <strong>18–25 players</strong>, with <strong>max 8 overseas</strong>.</li>
                  <li>Bid steps: <strong>₹0.05 / 0.10 / 0.20 / 0.25 cr</strong> slabs.</li>
                  <li>RTM is the modified version: the winner gets one more raise, then the old franchise can match.</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="panel team-select-panel">
            <div className="panel-title">Choose your franchises</div>
            <div className="team-grid">
              {sortedTeams.map((team) => {
                const selected = game.selectedFranchises.includes(team.id)
                const locked = !selected && game.selectedFranchises.length >= game.humanSeats
                return (
                  <button key={team.id} className={`team-card ${selected ? 'selected' : ''} ${locked ? 'locked' : ''}`} onClick={() => toggleFranchise(team.id)}>
                    <div className="crest" style={{ background: team.color, color: team.altColor }}>{team.id}</div>
                    <div>
                      <strong>{team.name}</strong>
                      <p>{team.perk.title}</p>
                    </div>
                    <small>{team.perk.description}</small>
                  </button>
                )
              })}
            </div>
          </div>
        </section>
      ) : (
        <section className="auction-grid">
          <aside className="side-panel">
            <div className="panel dossier-panel">
              <div className="panel-title">Active franchise dossier</div>
              {activeFranchise ? (
                <>
                  <button
                    type="button"
                    className="dossier-header"
                    style={{ background: `linear-gradient(135deg, ${activeFranchise.color}, ${activeFranchise.altColor})` }}
                    onClick={() => setActiveFranchise(activeFranchise.id)}
                  >
                    <div>
                      <div className="dossier-eyebrow">{activeFranchise.isHuman ? 'Your table' : 'Spotlighted table'}</div>
                      <h3>{activeFranchise.name}</h3>
                      <p>{activeFranchise.perk.title}: {activeFranchise.perk.description}</p>
                    </div>
                    <div className="dossier-crests">{activeFranchise.id}</div>
                  </button>
                  <div className="dossier-stats">
                    <span><strong>{formatPrice(activeFranchise.spent)}</strong> spent</span>
                    <span><strong>{formatPrice(activeFranchise.purse)}</strong> remaining</span>
                    <span><strong>{activeFranchise.rtmRemaining}</strong> RTM</span>
                    <span><strong>{activeFranchise.jumpBidUsed ? 'Used' : 'Ready'}</strong> jump</span>
                  </div>
                  <div className="dossier-counts">
                    {activeTeamCounts && (
                      <>
                        <span>B {activeTeamCounts.Batter}</span>
                        <span>AR {activeTeamCounts['All-rounder']}</span>
                        <span>WK {activeTeamCounts.Wicketkeeper}</span>
                        <span>Bowl {activeTeamCounts.Bowler}</span>
                      </>
                    )}
                    <span>{activeFranchise.overseasCount}/{AUCTION_CONFIG.maxOverseas} overseas</span>
                    <span>{activeFranchise.squad.length}/{getSquadMax(activeFranchise)} squad</span>
                  </div>
                  <div className="dossier-note">Title note: {activeFranchise.perk.title}</div>
                  <div className="dossier-roster">
                    {activeTeamSquad.length > 0 ? (
                      activeTeamSquad.map((player) => (
                        <div key={player.id} className="roster-row">
                          <img src={player.photoUrl} alt="" />
                          <div>
                            <strong>{player.name}</strong>
                            <small>{player.role} · {formatPrice(player.soldFor)}</small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="empty-roster">No players sold yet.</div>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty-roster">Select a franchise table to inspect its auction dossier.</div>
              )}
            </div>

            <div className="panel live-panel">
              <div className="panel-title">Auctioneer feed</div>
              <div className={`ticker ${auctionResult ? 'flash' : ''}`}>{auctioneerLine}</div>
              <div className="ticker-subline">
                <span className="badge">{game.auction.phase === 'auction' ? 'Live' : game.auction.phase}</span>
                <span className="badge">{game.auction.currentIndex + 1}/{game.auction.queue.length || players.length}</span>
                <span className="badge">{game.auction.acceleratedRound ? 'Accelerated' : 'Standard pace'}</span>
              </div>
              <div className="timer-ring">{game.auction.timer}s</div>
              <div className="live-bid">
                <span>Current bid</span>
                <strong>{formatPrice(game.auction.currentBid || currentPlayer?.basePrice || 0)}</strong>
              </div>
              <div className={`leader ${game.auction.highBidder ? 'flash' : ''}`}>{game.auction.highBidderName ?? 'No bid yet'}</div>
            </div>

            <div className="panel controls-panel">
              <div className="panel-title">Human controls</div>
              {game.auction.rtmPending && humanTeams.some((t) => t.id === game.auction.rtmPending!.previousTeam) ? (
                <div className="rtm-prompt">
                  <div className="rtm-label">RTM available — {FRANCHISE_MAP[game.auction.rtmPending.previousTeam].name}</div>
                  <p className="rtm-detail">Match {formatPrice(game.auction.rtmPending.finalBid)} for {game.auction.rtmPending.player.name}?</p>
                  <div className="rtm-actions">
                    <button className="primary small" onClick={useRtm}>Use RTM</button>
                    <button className="ghost small" onClick={passRtm}>Pass</button>
                  </div>
                </div>
              ) : (
                <div className="controls-grid">
                  {humanTeams.map((team) => (
                    <div key={team.id} className={`control-row ${activeFranchise?.id === team.id ? 'active' : ''}`}>
                      <button type="button" className="control-copy" onClick={() => setActiveFranchise(team.id)}>
                        <strong>{team.id}</strong>
                        <small>{formatPrice(team.purse)} left · {team.squad.length}/{getSquadMax(team)} squad</small>
                      </button>
                      <button className="primary small" onClick={() => placeHumanBid(team.id)} disabled={!currentPlayer || !canBid(team, currentPlayer, projectedHumanBid(team, currentPlayer, game.auction.currentBid || currentPlayer.basePrice))}>+{getIncrement(game.auction.currentBid || currentPlayer?.basePrice || 0).toFixed(2)}</button>
                      {team.id === 'PBKS' && !team.jumpBidUsed ? (
                        <button className="ghost small" onClick={() => placeHumanBid(team.id, true)} disabled={!currentPlayer || !canBid(team, currentPlayer, projectedHumanBid(team, currentPlayer, game.auction.currentBid || currentPlayer.basePrice, true))}>Jump</button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>

          <main className="main-stage">
            <div className={`big-screen panel ${auctionResult ? `result-${auctionResult.kind}` : ''}`} style={resultSweepStyle}>
              {auctionResult ? (
                <div className={`result-overlay result-overlay--${auctionResult.kind}`}>
                  <div className="result-overlay__badge">{auctionResult.kind === 'sold' ? 'SOLD' : 'UNSOLD'}</div>
                  <div className="result-overlay__copy">
                    <div className="eyebrow">Auction result</div>
                    <h3>{auctionResult.playerName}</h3>
                    <p>{auctionResult.line}</p>
                  </div>
                  <div className="result-overlay__team">
                    {auctionResult.kind === 'sold'
                      ? <>Winner: {auctionResult.teamName}<br />{auctionResult.amount ? formatPrice(auctionResult.amount) : null}</>
                      : <>Player returns to the pool</>}
                  </div>
                </div>
              ) : null}
              {currentPlayer ? (
                <>
                  {game.auction.acceleratedRound && (
                    <div className="accelerated-banner">Accelerated Round — reduced timer · {game.auction.queue.length - game.auction.currentIndex} player{game.auction.queue.length - game.auction.currentIndex !== 1 ? 's' : ''} remaining</div>
                  )}
                  <div className="screen-header">
                    <div>
                      <div className="eyebrow">Up next</div>
                      <h2>{currentPlayer.name}</h2>
                      <div className="spotlight-strip">
                        <span className="badge">Spotlight: {activeFranchise?.id ?? 'TBD'}</span>
                        <span className="badge">High bid: {game.auction.highBidderName ?? 'None'}</span>
                        <span className="badge">Queue depth: {game.auction.queue.length - game.auction.currentIndex - 1}</span>
                      </div>
                    </div>
                    <div className="badge-row">
                      <span className="badge">{currentPlayer.role}</span>
                      <span className="badge">{currentPlayer.nationality}</span>
                      <span className="badge">Base {formatPrice(currentPlayer.basePrice)}</span>
                      {currentPlayer.isOverseas ? <span className="badge overseas">Overseas</span> : <span className="badge domestic">Indian</span>}
                    </div>
                  </div>

                  <div className={`player-card ${auctionResult ? `result-${auctionResult.kind}` : ''}`}>
                    <img src={currentPlayer.photoUrl} alt={currentPlayer.name} />
                    <div className="player-core">
                      <div className="stat-strip">
                        <span>Form {currentPlayer.form}</span>
                        <span>{currentPlayer.isCapped ? 'Capped' : 'Uncapped'}</span>
                        <span>{currentPlayer.previousTeam ? `Ex-${currentPlayer.previousTeam}` : 'New face'}</span>
                      </div>
                      <div className={`auction-hammer ${auctionResult ? 'flash' : ''}`}>
                        <div>Hammer</div>
                        <strong>{formatPrice(game.auction.currentBid || currentPlayer.basePrice)}</strong>
                        <small>{currentPlayer.name} · {currentPlayer.role} · {currentPlayer.isOverseas ? 'Overseas' : 'Indian'}</small>
                      </div>
                      <p className={`player-note ${auctionResult ? 'flash' : ''}`}>{currentPlayer.isOverseas ? 'Overseas slot matters here. Bots know it, too.' : 'Homegrown talent gets a little extra bite from the room.'}</p>
                    </div>
                  </div>

                  <div className="stats-grid">
                    <div className="stats-box">
                      <div className="panel-title">Batting last 10 seasons</div>
                      <StatsTable player={currentPlayer} mode="batting" />
                    </div>
                    <div className="stats-box">
                      <div className="panel-title">Bowling last 10 seasons</div>
                      <StatsTable player={currentPlayer} mode="bowling" />
                    </div>
                    <div className="stats-box chart-box">
                      <div className="panel-title">Season trend</div>
                      <TrendChart player={currentPlayer} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-stage">
                  <h2>Auction complete</h2>
                  <p>Check the scoreboard and squad sheets below.</p>
                </div>
              )}
            </div>
          </main>

          <aside className="side-panel">
            <div className="panel scoreboard-panel">
              <div className="panel-title">Franchise tables</div>
              <div className="team-stacks">
                {teams.map((team) => (
                  <button
                    key={team.id}
                    type="button"
                    className={`franchise-table ${team.id === game.auction.highBidder ? 'highlight' : ''} ${activeFranchise?.id === team.id ? 'active' : ''}`}
                    style={{ borderColor: team.color }}
                    onClick={() => setActiveFranchise(team.id)}
                  >
                    <div className="table-top" style={{ background: team.color, color: team.altColor }}>
                      <strong>{team.id}</strong>
                      <small>{team.isHuman ? 'Human' : 'CPU'}</small>
                    </div>
                    <div className="table-body">
                      <div>{team.name}</div>
                      <div>{formatPrice(team.purse)} purse</div>
                      <div>{team.squad.length}/{getSquadMax(team)} squad</div>
                      <div>{team.overseasCount}/8 overseas</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="panel preview-panel">
              <div className="panel-title">Queue preview</div>
              <div className="preview-focus">
                {queueSpotlight ? (
                  <>
                    <div className="preview-focus-copy">
                      <div className="eyebrow">Now on deck</div>
                      <h3>{queueSpotlight.name}</h3>
                      <p>{queuePreviewLabel(queueSpotlight)}</p>
                    </div>
                    <div className="preview-focus-meta">
                      <span>Form {queueSpotlight.form}</span>
                      <span>{queueSpotlight.isCapped ? 'Capped' : 'Uncapped'}</span>
                      {rrPreviewSlots > 0 ? <span className="badge rr-perk">RR sees +1 preview</span> : null}
                    </div>
                  </>
                ) : (
                  <div className="empty-roster">Queue is loading.</div>
                )}
              </div>
              <div className="preview-list">
                {previewPlayers.slice(1).map((player, index) => (
                  <div key={`${player.id}-${index}`} className={`preview-row ${index === 0 ? 'next' : ''}`}>
                    <img src={player.photoUrl} alt="" />
                    <div>
                      <strong>{player.name}</strong>
                      <small>#{game.auction.currentIndex + index + 2} · {queuePreviewLabel(player)}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>
      )}

      <section className="bottom-grid">
        <div className="panel">
          <div className="panel-title">Squad tracker</div>
          <div className="squad-grid">
            {teams.map((team) => (
              <SquadCard key={team.id} team={team} active={activeFranchise?.id === team.id} onOpen={() => setActiveFranchise(team.id)} />
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Scoreboard</div>
          <div className="score-list">
            {leaderboard.map(({ team, strength, eff, validation }, index) => (
              <div key={team.id} className={`score-row ${game.auction.winner === team.id ? 'winner' : ''} ${validation.valid ? '' : 'invalid'}`}>
                <strong>#{index + 1} {team.id}</strong>
                <span>{team.name}</span>
                <span>Strength {strength.toFixed(1)}</span>
                <span>₹ efficiency {eff.toFixed(2)}</span>
                <span>{validation.valid ? 'Valid' : validation.reasons.join(' · ')}</span>
              </div>
            ))}
          </div>
          {game.auction.phase === 'finished' ? <div className="winner-banner">Winner: {game.auction.winner ? FRANCHISE_MAP[game.auction.winner].name : 'TBD'}</div> : null}
        </div>

        <div className="panel">
          <div className="panel-title">Live log</div>
          <div className="log-list">
            {[...game.auction.log].slice(-12).reverse().map((line, index) => (
              <div key={`${line}-${index}`} className="log-line">{line}</div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function StatsTable({ player, mode }: { player: PlayerRecord; mode: 'batting' | 'bowling' }) {
  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th>Season</th>
            <th>{mode === 'batting' ? 'Runs' : 'Wkts'}</th>
            <th>{mode === 'batting' ? 'SR' : 'Econ'}</th>
            <th>Avg</th>
          </tr>
        </thead>
        <tbody>
          {player.seasons.map((season) => {
            if (mode === 'batting') {
              const stat = season.batting
              return (
                <tr key={`${season.season}-${mode}`}>
                  <td>{season.season}</td>
                  <td>{stat ? stat.runs : '—'}</td>
                  <td>{stat ? stat.strikeRate.toFixed(1) : '—'}</td>
                  <td>{stat ? stat.average.toFixed(1) : '—'}</td>
                </tr>
              )
            }

            const stat = season.bowling
            return (
              <tr key={`${season.season}-${mode}`}>
                <td>{season.season}</td>
                <td>{stat ? stat.wickets : '—'}</td>
                <td>{stat ? stat.economy.toFixed(1) : '—'}</td>
                <td>{stat ? stat.average.toFixed(1) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TrendChart({ player }: { player: PlayerRecord }) {
  const values = player.seasons.map((season) => season.batting?.runs ?? season.bowling?.wickets ?? 0)
  const max = Math.max(1, ...values)
  return (
    <div className="trend-chart">
      {values.map((value, index) => (
        <div key={`${player.id}-${index}`} className="trend-bar-wrap">
          <div className="trend-bar" style={{ height: `${Math.max(12, (value / max) * 100)}%` }} />
          <small>{player.seasons[index].season % 100}</small>
        </div>
      ))}
    </div>
  )
}

function SquadCard({
  team,
  active,
  onOpen,
}: {
  team: FranchiseState
  active: boolean
  onOpen: () => void
}) {
  const roster = squadPreview(team)
  return (
    <button type="button" className={`squad-card ${active ? 'active' : ''}`} style={{ borderColor: team.color }} onClick={onOpen}>
      <div className="squad-card-head" style={{ background: team.color, color: team.altColor }}>
        <strong>{team.id}</strong>
        <span>{team.squad.length} players</span>
      </div>
      <div className="squad-card-body">
        <div className="squad-meta">
          <span>Spent {formatPrice(team.spent)}</span>
          <span>Remaining {formatPrice(team.purse)}</span>
          <span>Overseas {team.overseasCount}</span>
        </div>
        <div className="mini-squad">
          {roster.slice(0, 6).map((player) => (
            <span key={player.id} className="mini-player">{player.name.split(' ')[0]}</span>
          ))}
          {roster.length > 6 ? <span className="mini-player">+{roster.length - 6}</span> : null}
        </div>
      </div>
    </button>
  )
}

export default App
