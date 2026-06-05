import { useEffect, useMemo, useState } from 'react'
import './styles.css'
import { AUCTION_CONFIG, FRANCHISE_MAP, FRANCHISES } from './lib/config'
import {
  addPlayerToTeam,
  botWillingness,
  canAfford,
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
const sortedPlayers = [...SAMPLE_PLAYERS].sort((a, b) => b.form - a.form)

type GameState = {
  humanSeats: number
  selectedFranchises: FranchiseId[]
  franchises: Record<FranchiseId, FranchiseState>
  auction: AuctionState
}

function initialAuction(): AuctionState {
  return {
    pool: sortedPlayers,
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

function initialGame(): GameState {
  const selectedFranchises: FranchiseId[] = ['CSK']
  return {
    humanSeats: 1,
    selectedFranchises,
    franchises: createFranchises(selectedFranchises),
    auction: initialAuction(),
  }
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
  const [game, setGame] = useState<GameState>(initialGame)

  const currentPlayer = game.auction.queue[game.auction.currentIndex]
  const teams = Object.values(game.franchises)
  const humanTeams = teams.filter((team) => team.isHuman)
  const botTeams = teams.filter((team) => !team.isHuman)
  const previewPlayers = useMemo(() => {
    const extra = game.selectedFranchises.includes('RR') ? 1 : 0
    return game.auction.queue.slice(game.auction.currentIndex, game.auction.currentIndex + 3 + extra)
  }, [game.auction.currentIndex, game.auction.queue, game.selectedFranchises])

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
    const picked: FranchiseId[] = game.selectedFranchises.length ? game.selectedFranchises : ['CSK']
    const shuffled = shuffle(sortedPlayers)
    const first = shuffled[0]
    setGame((prev: GameState) => ({
      ...prev,
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
    setGame(initialGame())
  }

  function ensureHumanSeats(nextSeats: number) {
    setGame((prev: GameState) => {
      const selected = prev.selectedFranchises.slice(0, nextSeats) as FranchiseId[]
      return {
        ...prev,
        humanSeats: nextSeats,
        selectedFranchises: selected,
        franchises: prev.auction.phase === 'setup' ? createFranchises(selected) : prev.franchises,
      }
    })
  }

  function toggleFranchise(id: FranchiseId) {
    setGame((prev: GameState) => {
      const exists = prev.selectedFranchises.includes(id)
      if (exists) {
        const selected = prev.selectedFranchises.filter((team) => team !== id) as FranchiseId[]
        return { ...prev, selectedFranchises: selected, franchises: prev.auction.phase === 'setup' ? createFranchises(selected) : prev.franchises }
      }
      if (prev.selectedFranchises.length >= prev.humanSeats) return prev
        const selected = [...prev.selectedFranchises, id] as FranchiseId[]
      return { ...prev, selectedFranchises: selected, franchises: prev.auction.phase === 'setup' ? createFranchises(selected) : prev.franchises }
    })
  }

  function placeHumanBid(teamId: FranchiseId, jump = false) {
    setGame((prev: GameState) => bid(prev, teamId, jump))
  }

  function bid(gameState: GameState, teamId: FranchiseId, jump = false): GameState {
    if (gameState.auction.phase !== 'auction' || !gameState.auction.currentPlayer) return gameState
    const team = gameState.franchises[teamId]
    const player = gameState.auction.currentPlayer
    const currentBid = gameState.auction.currentBid || player.basePrice
    const candidateBid = jump ? jumpBid(team, currentBid) : currentBid + getIncrement(currentBid)
    const effectiveBid = Number(humanDiscount(team, player, candidateBid).toFixed(2))
    if (!canAfford(team, effectiveBid, gameState.humanSeats)) return gameState
    if (gameState.auction.highBidder === teamId && !jump) return gameState

    return {
      ...gameState,
      auction: {
        ...gameState.auction,
        currentBid: effectiveBid,
        highBidder: teamId,
        highBidderName: team.name,
        timer: timerForPlayer(gameState.selectedFranchises),
        auctioneerLine: `${team.name} leads on ${player.name}.`,
        log: [...gameState.auction.log, `${team.name} bids ${formatPrice(effectiveBid)}${jump ? ' (jump)' : ''}`],
      },
    }
  }

  function maybeBotBid(gameState: GameState): GameState {
    if (gameState.auction.phase !== 'auction' || !gameState.auction.currentPlayer) return gameState
    const player = gameState.auction.currentPlayer
    const currentBid = gameState.auction.currentBid || player.basePrice
    const increment = getIncrement(currentBid)
    const queueSize = gameState.auction.queue.length - gameState.auction.currentIndex

    const best = botTeams
      .map((team) => ({ team, willingness: botWillingness(team, player, queueSize, gameState.humanSeats) }))
      .filter(({ team, willingness }) => willingness >= currentBid + increment && canAfford(team, currentBid + increment, gameState.humanSeats))
      .sort((a, b) => b.willingness - a.willingness)[0]

    if (!best) return gameState

    const candidateBid = best.team.id === 'PBKS' && !best.team.jumpBidUsed && best.willingness >= currentBid + increment * 2 ? jumpBid(best.team, currentBid) : currentBid + increment
    const effectiveBid = Number(humanDiscount(best.team, player, candidateBid).toFixed(2))
    if (!canAfford(best.team, effectiveBid, gameState.humanSeats)) return gameState

    return {
      ...gameState,
      auction: {
        ...gameState.auction,
        currentBid: effectiveBid,
        highBidder: best.team.id,
        highBidderName: best.team.name,
        timer: Math.max(gameState.auction.timer, 3),
        auctioneerLine: `${best.team.name} raises the paddle.`,
        log: [...gameState.auction.log, `${best.team.name} bids ${formatPrice(effectiveBid)}`],
      },
    }
  }

  function settleCurrent(gameState: GameState): GameState {
    const player = gameState.auction.currentPlayer
    if (!player) return finishAuction(gameState)

    if (!gameState.auction.highBidder) {
      return advanceAfterSettle({
        ...gameState,
        auction: {
          ...gameState.auction,
          unsold: [...gameState.auction.unsold, player],
          log: [...gameState.auction.log, `${player.name} goes UNSOLD.`],
          auctioneerLine: `${player.name} is left for the accelerated round.`,
        },
      })
    }

    let winner = gameState.auction.highBidder
    let hammer = gameState.auction.currentBid
    const previousTeamId = player.previousTeam

    if (previousTeamId && previousTeamId !== winner) {
      const previousTeam = gameState.franchises[previousTeamId]
      if (previousTeam && previousTeam.rtmRemaining > 0 && canAfford(previousTeam, hammer, gameState.humanSeats)) {
        winner = previousTeamId
        const updatedPrevious = { ...previousTeam, rtmRemaining: previousTeam.rtmRemaining - 1 }
        const updatedFranchises = { ...gameState.franchises, [previousTeamId]: updatedPrevious }
        const sale = saleDiscount(updatedPrevious, player, hammer)
        const updatedWinner = addPlayerToTeam(updatedPrevious, player, sale)
        updatedFranchises[previousTeamId] = updatedWinner
        return advanceAfterSettle({
          ...gameState,
          franchises: updatedFranchises,
          auction: {
            ...gameState.auction,
            log: [...gameState.auction.log, `${updatedPrevious.name} uses RTM and matches ${formatPrice(hammer)}.`],
            auctioneerLine: `${updatedPrevious.name} snatches ${player.name} back.`,
          },
        })
      }
    }

    const winningTeam = gameState.franchises[winner]
    const sale = saleDiscount(winningTeam, player, hammer)
    const updatedFranchises = {
      ...gameState.franchises,
      [winner]: addPlayerToTeam(winningTeam, player, sale),
    }

    return advanceAfterSettle({
      ...gameState,
      franchises: updatedFranchises,
      auction: {
        ...gameState.auction,
        log: [...gameState.auction.log, `${player.name} SOLD to ${winningTeam.name} for ${formatPrice(sale)}`],
        auctioneerLine: `${player.name} SOLD to ${winningTeam.name}.`,
      },
    })
  }

  function advanceAfterSettle(gameState: GameState): GameState {
    const nextIndex = gameState.auction.currentIndex + 1
    if (nextIndex < gameState.auction.queue.length) {
      const nextPlayer = gameState.auction.queue[nextIndex]
      return {
        ...gameState,
        auction: {
          ...gameState.auction,
          currentIndex: nextIndex,
          currentPlayer: nextPlayer,
          currentBid: nextPlayer.basePrice,
          highBidder: undefined,
          highBidderName: undefined,
          timer: timerForPlayer(gameState.selectedFranchises),
          auctioneerLine: `${nextPlayer.name} takes centre stage.`,
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
          queue,
          unsold: [],
          currentIndex: 0,
          currentPlayer: nextPlayer,
          currentBid: nextPlayer.basePrice,
          highBidder: undefined,
          highBidderName: undefined,
          timer: AUCTION_CONFIG.acceleratedTimerSeconds,
          acceleratedRound: true,
          auctioneerLine: 'Accelerated round: unsold players return.',
          log: [...gameState.auction.log, 'Accelerated round begins.'],
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

  function finishAuction(gameState: GameState): GameState {
    const scored = Object.values(gameState.franchises)
      .map((team) => ({ team, strength: teamStrength(team), eff: efficiency(team), validation: validateSquad(team) }))
      .sort((a, b) => b.strength - a.strength)
    const winner = scored[0]?.team.id
    return {
      ...gameState,
      auction: {
        ...gameState.auction,
        phase: 'finished',
        winner,
        currentPlayer: undefined,
        auctioneerLine: winner ? `${FRANCHISE_MAP[winner].name} tops the board.` : 'Auction complete.',
        log: [...gameState.auction.log, winner ? `Winner: ${FRANCHISE_MAP[winner].name}` : 'Auction complete.'],
      },
    }
  }

  const leaderboard = useMemo(() => {
    return Object.values(game.franchises)
      .map((team) => ({ team, strength: teamStrength(team), eff: efficiency(team), validation: validateSquad(team) }))
      .sort((a, b) => b.strength - a.strength)
  }, [game.franchises])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">IPL auction hall</div>
          <h1>Player Auction Game</h1>
        </div>
        <div className="topbar-stats">
          <span>{game.humanSeats} human seat{game.humanSeats > 1 ? 's' : ''}</span>
          <span>{game.auction.queue.length || sortedPlayers.length} players</span>
          <span>{game.auction.phase === 'finished' ? 'Auction closed' : game.auction.phase === 'auction' ? 'Live bidding' : 'Lobby'}</span>
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
            <div className="panel live-panel">
              <div className="panel-title">Auctioneer feed</div>
              <div className="ticker">{game.auction.auctioneerLine}</div>
              <div className="timer-ring">{game.auction.timer}s</div>
              <div className="live-bid">
                <span>Current bid</span>
                <strong>{formatPrice(game.auction.currentBid || currentPlayer?.basePrice || 0)}</strong>
              </div>
              <div className={`leader ${game.auction.highBidder ? 'flash' : ''}`}>{game.auction.highBidderName ?? 'No bid yet'}</div>
            </div>

            <div className="panel controls-panel">
              <div className="panel-title">Human controls</div>
              <div className="controls-grid">
                {humanTeams.map((team) => (
                  <div key={team.id} className="control-row">
                    <div>
                      <strong>{team.id}</strong>
                      <small>{formatPrice(team.purse)} left</small>
                    </div>
                    <button className="primary small" onClick={() => placeHumanBid(team.id)} disabled={!currentPlayer || team.purse <= 0}>+{getIncrement(game.auction.currentBid || currentPlayer?.basePrice || 0).toFixed(2)}</button>
                    {team.id === 'PBKS' && !team.jumpBidUsed ? (
                      <button className="ghost small" onClick={() => placeHumanBid(team.id, true)} disabled={!currentPlayer}>Jump</button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </aside>

          <main className="main-stage">
            <div className="big-screen panel">
              {currentPlayer ? (
                <>
                  <div className="screen-header">
                    <div>
                      <div className="eyebrow">Up next</div>
                      <h2>{currentPlayer.name}</h2>
                    </div>
                    <div className="badge-row">
                      <span className="badge">{currentPlayer.role}</span>
                      <span className="badge">{currentPlayer.nationality}</span>
                      <span className="badge">Base {formatPrice(currentPlayer.basePrice)}</span>
                      {currentPlayer.isOverseas ? <span className="badge overseas">Overseas</span> : <span className="badge domestic">Indian</span>}
                    </div>
                  </div>

                  <div className="player-card">
                    <img src={currentPlayer.photoUrl} alt={currentPlayer.name} />
                    <div className="player-core">
                      <div className="stat-strip">
                        <span>Form {currentPlayer.form}</span>
                        <span>{currentPlayer.isCapped ? 'Capped' : 'Uncapped'}</span>
                        <span>{currentPlayer.previousTeam ? `Ex-${currentPlayer.previousTeam}` : 'New face'}</span>
                      </div>
                      <div className="auction-hammer">
                        <div>Hammer</div>
                        <strong>{formatPrice(game.auction.currentBid || currentPlayer.basePrice)}</strong>
                        <small>{currentPlayer.name} · {currentPlayer.role} · {currentPlayer.isOverseas ? 'Overseas' : 'Indian'}</small>
                      </div>
                      <p className="player-note">{currentPlayer.isOverseas ? 'Overseas slot matters here. Bots know it, too.' : 'Homegrown talent gets a little extra bite from the room.'}</p>
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
                  <div key={team.id} className={`franchise-table ${team.id === game.auction.highBidder ? 'highlight' : ''}`} style={{ borderColor: team.color }}>
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
                  </div>
                ))}
              </div>
            </div>

            <div className="panel preview-panel">
              <div className="panel-title">Queue preview</div>
              <div className="preview-list">
                {previewPlayers.map((player, index) => (
                  <div key={`${player.id}-${index}`} className="preview-row">
                    <img src={player.photoUrl} alt="" />
                    <div>
                      <strong>{player.name}</strong>
                      <small>{player.role} · {formatPrice(player.basePrice)}</small>
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
              <SquadCard key={team.id} team={team} />
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Scoreboard</div>
          <div className="score-list">
            {leaderboard.map(({ team, strength, eff, validation }, index) => (
              <div key={team.id} className={`score-row ${game.auction.winner === team.id ? 'winner' : ''}`}>
                <strong>#{index + 1} {team.id}</strong>
                <span>{team.name}</span>
                <span>Strength {strength.toFixed(1)}</span>
                <span>₹ efficiency {eff.toFixed(2)}</span>
                <span>{validation.valid ? 'Valid' : 'Needs work'}</span>
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

function SquadCard({ team }: { team: FranchiseState }) {
  return (
    <div className="squad-card" style={{ borderColor: team.color }}>
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
          {team.squad.slice(0, 6).map((player) => (
            <span key={player.id} className="mini-player">{player.name.split(' ')[0]}</span>
          ))}
          {team.squad.length > 6 ? <span className="mini-player">+{team.squad.length - 6}</span> : null}
        </div>
      </div>
    </div>
  )
}

export default App
