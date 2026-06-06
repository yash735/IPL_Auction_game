import type { AuctionConfig, FranchiseId, FranchiseMeta } from './types'

export const AUCTION_CONFIG: AuctionConfig = {
  initialPurse: 120,
  minSquadSize: 18,
  maxSquadSize: 25,
  maxOverseas: 8,
  rtmCards: 1,
  bidTimerSeconds: 12,
  acceleratedTimerSeconds: 7,
  minBasePurseReserve: 0.2,
}

export const FRANCHISES: FranchiseMeta[] = [
  {
    id: 'CSK',
    name: 'Chennai Super Kings',
    color: '#f9cd05',
    altColor: '#14213d',
    perk: { title: 'Cool Head', description: 'Bid timer is 20% longer for you.' },
  },
  {
    id: 'MI',
    name: 'Mumbai Indians',
    color: '#004ba0',
    altColor: '#08b1ff',
    perk: { title: 'Title Pedigree', description: '+1 extra RTM card.' },
  },
  {
    id: 'RCB',
    name: 'Royal Challengers Bengaluru',
    color: '#d71920',
    altColor: '#111111',
    perk: { title: 'Galacticos', description: '10% discount on your first 2 batters.' },
  },
  {
    id: 'KKR',
    name: 'Kolkata Knight Riders',
    color: '#3a225d',
    altColor: '#b59d57',
    perk: { title: 'Spin Web', description: '10% discount on spin bowlers.' },
  },
  {
    id: 'SRH',
    name: 'Sunrisers Hyderabad',
    color: '#f26522',
    altColor: '#ffffff',
    perk: { title: 'Orange Army', description: '+₹5 cr starting purse.' },
  },
  {
    id: 'DC',
    name: 'Delhi Capitals',
    color: '#0078bc',
    altColor: '#174ea6',
    perk: { title: 'Youth Academy', description: 'Uncapped/young players cost 15% less.' },
  },
  {
    id: 'RR',
    name: 'Rajasthan Royals',
    color: '#e3007b',
    altColor: '#1f1f1f',
    perk: { title: 'Moneyball', description: 'See one extra upcoming player in the queue.' },
  },
  {
    id: 'PBKS',
    name: 'Punjab Kings',
    color: '#dc3c50',
    altColor: '#ffffff',
    perk: { title: 'Big Spender', description: 'One jump bid can exceed the normal increment.' },
  },
  {
    id: 'GT',
    name: 'Gujarat Titans',
    color: '#1b1c3f',
    altColor: '#77d4ff',
    perk: { title: 'Smart Auction', description: 'Refund 5% on every steal from another owner.' },
  },
  {
    id: 'LSG',
    name: 'Lucknow Super Giants',
    color: '#3a80d6',
    altColor: '#dbeafe',
    perk: { title: 'Deep Pockets', description: '+₹8 cr purse, but −1 max squad size.' },
  },
]

export const FRANCHISE_MAP = Object.fromEntries(FRANCHISES.map((team) => [team.id, team])) as Record<FranchiseId, FranchiseMeta>

export const MIN_BID_BREAKPOINTS = [
  { upto: 1, increment: 0.05 },
  { upto: 2, increment: 0.1 },
  { upto: 5, increment: 0.2 },
  { upto: Number.POSITIVE_INFINITY, increment: 0.25 },
]

export function getBidIncrement(price: number) {
  return MIN_BID_BREAKPOINTS.find((band) => price <= band.upto)?.increment ?? 0.25
}
