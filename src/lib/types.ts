export type FranchiseId =
  | 'CSK'
  | 'MI'
  | 'RCB'
  | 'KKR'
  | 'SRH'
  | 'DC'
  | 'RR'
  | 'PBKS'
  | 'GT'
  | 'LSG'

export type Role = 'Batter' | 'Bowler' | 'All-rounder' | 'Wicketkeeper'
export type Nationality = 'India' | 'Australia' | 'England' | 'South Africa' | 'West Indies' | 'Sri Lanka' | 'New Zealand' | 'Afghanistan'

export interface SeasonBattingStats {
  matches: number
  innings: number
  runs: number
  balls: number
  strikeRate: number
  average: number
  fifties: number
  hundreds: number
  highestScore: number
  boundaryPct: number
}

export interface SeasonBowlingStats {
  matches: number
  wickets: number
  balls: number
  runsConceded: number
  economy: number
  average: number
  bestFigures: string
}

export interface PlayerSeasonSnapshot {
  season: number
  batting?: SeasonBattingStats
  bowling?: SeasonBowlingStats
  played: boolean
}

export interface PlayerRecord {
  id: string
  name: string
  role: Role
  nationality: Nationality
  isOverseas: boolean
  isCapped: boolean
  basePrice: number
  form: number
  previousTeam?: FranchiseId
  photoUrl: string
  seasons: PlayerSeasonSnapshot[]
  career: {
    batting: SeasonBattingStats
    bowling: SeasonBowlingStats
  }
}

export interface TeamPerk {
  title: string
  description: string
}

export interface FranchiseMeta {
  id: FranchiseId
  name: string
  color: string
  altColor: string
  perk: TeamPerk
}

export interface SquadPlayer extends PlayerRecord {
  soldFor: number
  auctionTeam: FranchiseId
}

export interface FranchiseState {
  id: FranchiseId
  name: string
  color: string
  altColor: string
  perk: TeamPerk
  isHuman: boolean
  purse: number
  spent: number
  squad: SquadPlayer[]
  overseasCount: number
  bidAggression: number
  hoardBias: number
  needBias: Record<'Batter' | 'Bowler' | 'All-rounder' | 'Wicketkeeper', number>
  rtmRemaining: number
  jumpBidUsed: boolean
}

export interface AuctionConfig {
  initialPurse: number
  minSquadSize: number
  maxSquadSize: number
  maxOverseas: number
  rtmCards: number
  bidTimerSeconds: number
  acceleratedTimerSeconds: number
  minBasePurseReserve: number
}

export interface AuctionState {
  pool: PlayerRecord[]
  queue: PlayerRecord[]
  currentIndex: number
  currentPlayer?: PlayerRecord
  currentBid: number
  highBidder?: FranchiseId
  highBidderName?: string
  phase: 'setup' | 'select' | 'auction' | 'sold' | 'unsold' | 'finished'
  timer: number
  auctioneerLine: string
  log: string[]
  rtmPending?: {
    player: PlayerRecord
    winner: FranchiseId
    finalBid: number
    previousTeam: FranchiseId
  }
  unsold: PlayerRecord[]
  acceleratedRound: boolean
  winner?: FranchiseId
}

export interface AuctionContext {
  config: AuctionConfig
  franchises: Record<FranchiseId, FranchiseState>
  humanSeats: number
  selectedFranchises: FranchiseId[]
  selectedPlayerCount: number
  mode: 'single' | 'pass-and-play'
  perksUnlocked: Record<FranchiseId, boolean>
}
