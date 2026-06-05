import { AUCTION_CONFIG, FRANCHISE_MAP, getBidIncrement } from './config'
import type {
  AuctionContext,
  AuctionState,
  FranchiseId,
  FranchiseState,
  PlayerRecord,
  Role,
  SquadPlayer,
} from './types'

const ROLE_NEEDS: Record<Role, number> = {
  Batter: 1.0,
  Bowler: 1.0,
  'All-rounder': 1.2,
  Wicketkeeper: 1.05,
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function teamReserve(team: FranchiseState, selectedPlayerCount: number) {
  const minSlots = Math.max(0, AUCTION_CONFIG.minSquadSize - team.squad.length)
  const extra = Math.max(0, selectedPlayerCount - team.squad.length)
  return Math.max(minSlots, extra) * AUCTION_CONFIG.minBasePurseReserve
}

export function createFranchises(selectedHumanFranchises: FranchiseId[]): Record<FranchiseId, FranchiseState> {
  const result = {} as Record<FranchiseId, FranchiseState>
  for (const meta of Object.values(FRANCHISE_MAP)) {
    const isHuman = selectedHumanFranchises.includes(meta.id)
    const basePurse = AUCTION_CONFIG.initialPurse + (meta.id === 'SRH' ? 5 : 0) + (meta.id === 'LSG' ? 8 : 0)
    result[meta.id] = {
      id: meta.id,
      name: meta.name,
      color: meta.color,
      altColor: meta.altColor,
      perk: meta.perk,
      isHuman,
      purse: basePurse,
      spent: 0,
      squad: [],
      overseasCount: 0,
      bidAggression: meta.id === 'PBKS' ? 1.18 : meta.id === 'MI' ? 1.12 : meta.id === 'RCB' ? 1.08 : meta.id === 'GT' ? 0.96 : 1,
      hoardBias: meta.id === 'LSG' || meta.id === 'SRH' ? 1.15 : meta.id === 'GT' ? 1.08 : 0.96,
      needBias: {
        Batter: meta.id === 'RCB' ? 1.14 : meta.id === 'MI' ? 1.06 : 1,
        Bowler: meta.id === 'KKR' ? 1.1 : meta.id === 'SRH' ? 1.08 : 1,
        'All-rounder': meta.id === 'DC' ? 1.08 : 1,
        Wicketkeeper: meta.id === 'CSK' ? 1.04 : 1,
      },
      rtmRemaining: AUCTION_CONFIG.rtmCards + (meta.id === 'MI' ? 1 : 0),
      jumpBidUsed: false,
    }
  }

  return result
}

export function getSquadMax(team: FranchiseState) {
  return AUCTION_CONFIG.maxSquadSize - (team.id === 'LSG' ? 1 : 0)
}

export function getIncrement(price: number) {
  return getBidIncrement(price)
}

export function canAfford(team: FranchiseState, bid: number, selectedPlayerCount = 0) {
  if (team.purse < bid) return false
  if (team.squad.length >= getSquadMax(team)) return false
  if (team.overseasCount >= AUCTION_CONFIG.maxOverseas) return false
  const reserve = teamReserve(team, selectedPlayerCount)
  return team.purse - bid >= reserve
}

export function canTakePlayer(team: FranchiseState, player: PlayerRecord, selectedPlayerCount = 0) {
  if (team.squad.length >= getSquadMax(team)) return false
  if (player.isOverseas && team.overseasCount >= AUCTION_CONFIG.maxOverseas) return false
  return canAfford(team, player.basePrice, selectedPlayerCount)
}

export function roleNeed(team: FranchiseState, player: PlayerRecord) {
  const base = ROLE_NEEDS[player.role]
  return clamp(base * (team.needBias[player.role] ?? 1), 0.85, 1.45)
}

export function scarcityMultiplier(player: PlayerRecord, queueSize: number) {
  const roleCount = queueSize <= 0 ? 1 : queueSize
  const scarcity = player.isOverseas ? 1.08 : 1
  const formBoost = 0.65 + player.form / 125
  return scarcity * formBoost * (1 + Math.min(0.12, 20 / (roleCount + 20)))
}

export function botWillingness(team: FranchiseState, player: PlayerRecord, queueSize: number, selectedPlayerCount = 0) {
  if (!canTakePlayer(team, player, selectedPlayerCount)) return 0
  const roleNeedValue = roleNeed(team, player)
  const scarcity = scarcityMultiplier(player, queueSize)
  const personality = team.bidAggression / team.hoardBias
  const perkBoost =
    team.id === 'GT' ? 1.02 : team.id === 'PBKS' ? 1.04 : team.id === 'MI' ? 1.03 : team.id === 'LSG' ? 0.98 : 1
  const value = player.basePrice * (1.05 + (player.form / 100) * 0.9 * roleNeedValue * scarcity * personality * perkBoost)
  const cap = team.purse - Math.max(0, (AUCTION_CONFIG.minSquadSize - team.squad.length - 1) * AUCTION_CONFIG.minBasePurseReserve)
  return Math.max(0, Math.min(Number(cap.toFixed(2)), Number(value.toFixed(2))))
}

export function humanDiscount(team: FranchiseState, player: PlayerRecord, currentBid: number) {
  if (team.id === 'RCB' && player.role === 'Batter' && team.squad.filter((p) => p.role === 'Batter').length < 2) {
    return currentBid * 0.9
  }
  if (team.id === 'KKR' && player.role === 'Bowler' && player.nationality === 'India') {
    return currentBid * 0.9
  }
  if (team.id === 'DC' && !player.isCapped) {
    return currentBid * 0.85
  }
  return currentBid
}

export function jumpBid(team: FranchiseState, currentBid: number) {
  if (team.id !== 'PBKS' || team.jumpBidUsed) return currentBid + getIncrement(currentBid)
  team.jumpBidUsed = true
  return currentBid + getIncrement(currentBid) * 2
}

export function addPlayerToTeam(team: FranchiseState, player: PlayerRecord, soldFor: number): FranchiseState {
  const squadPlayer: SquadPlayer = {
    ...player,
    soldFor,
    auctionTeam: team.id,
  }
  return {
    ...team,
    purse: Number((team.purse - soldFor).toFixed(2)),
    spent: Number((team.spent + soldFor).toFixed(2)),
    squad: [...team.squad, squadPlayer],
    overseasCount: team.overseasCount + (player.isOverseas ? 1 : 0),
  }
}

export function teamStrength(team: FranchiseState) {
  const balance = team.squad.length === 0 ? 0 : Math.min(1.15, 0.85 + team.squad.length / 24)
  const roleSpread = ['Batter', 'Bowler', 'All-rounder', 'Wicketkeeper']
    .map((role) => team.squad.filter((p) => p.role === role).length)
    .filter((count) => count > 0).length
  const balanceBonus = 1 + Math.min(0.12, roleSpread * 0.03)
  const overseasPenalty = team.overseasCount > AUCTION_CONFIG.maxOverseas ? 0.85 : 1
  const core = team.squad.reduce((sum, p) => sum + p.form * (p.role === 'All-rounder' ? 1.1 : 1), 0)
  return Number((core * balance * balanceBonus * overseasPenalty).toFixed(2))
}

export function efficiency(team: FranchiseState) {
  if (team.spent <= 0) return 0
  return Number((teamStrength(team) / team.spent).toFixed(2))
}

export function validateSquad(team: FranchiseState) {
  const size = team.squad.length
  const overseasOk = team.overseasCount <= AUCTION_CONFIG.maxOverseas
  const sizeOk = size >= AUCTION_CONFIG.minSquadSize && size <= getSquadMax(team)
  const purseOk = team.purse >= 0
  return { valid: overseasOk && sizeOk && purseOk, sizeOk, overseasOk, purseOk }
}

export function formatPrice(value: number) {
  return `₹${value.toFixed(2)} cr`
}

export function playerSummary(player: PlayerRecord) {
  return `${player.name} · ${player.role} · ${player.isOverseas ? 'Overseas' : 'Indian'} · form ${player.form}`
}

export function nextBidderNames(franchises: Record<FranchiseId, FranchiseState>) {
  return Object.values(franchises)
    .filter((team) => team.purse > 0 && team.squad.length < getSquadMax(team))
    .map((team) => team.name)
}
