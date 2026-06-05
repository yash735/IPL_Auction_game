import unittest

from scripts import generate_auction_pool as gp


class GenerateAuctionPoolTests(unittest.TestCase):
    def test_normalize_key_strips_noise(self):
        self.assertEqual(gp.normalize_key('  A.B. de Villiers  '), 'ab-de-villiers')
        self.assertEqual(gp.normalize_key('S. R. Watson'), 's-r-watson')

    def test_aggregate_single_match_delivery_stats(self):
        match = {
            'meta': {'created': '2016-05-29'},
            'info': {'season': 2016, 'players': {'Team A': ['Player One', 'Player Two'], 'Team B': ['Bowler One', 'Bowler Two']}, 'registry': {'people': {'Player One': 'p1', 'Bowler One': 'b1'}}},
            'innings': [
                {
                    'team': 'Team A',
                    'overs': [
                        {
                            'deliveries': [
                                {'batter': 'Player One', 'bowler': 'Bowler One', 'runs': {'batter': 4, 'extras': 0, 'total': 4}},
                                {'batter': 'Player One', 'bowler': 'Bowler One', 'runs': {'batter': 1, 'extras': 0, 'total': 1}},
                                {'batter': 'Player Two', 'bowler': 'Bowler One', 'runs': {'batter': 0, 'extras': 0, 'total': 0}, 'wickets': [{'kind': 'bowled', 'player_out': 'Player Two'}]},
                            ]
                        }
                    ],
                }
            ],
        }
        stats = gp.aggregate_matches([match])
        self.assertIn('player-one', stats)
        self.assertIn('bowler-one', stats)
        player = stats['player-one']
        self.assertEqual(player['career']['batting']['runs'], 5)
        self.assertEqual(player['career']['batting']['balls'], 2)
        self.assertEqual(player['career']['batting']['strikeRate'], 250.0)
        bowler = stats['bowler-one']
        self.assertEqual(bowler['career']['bowling']['wickets'], 1)
        self.assertEqual(bowler['career']['bowling']['balls'], 3)

    def test_merge_records_prefers_meta_and_sorts_by_form(self):
        players = {
            'player-one': {'name': 'Player One', 'career': {'batting': {}, 'bowling': {}}, 'seasons': []},
            'player-two': {'name': 'Player Two', 'career': {'batting': {}, 'bowling': {}}, 'seasons': []},
        }
        meta = {
            'player-one': {'name': 'Player One', 'role': 'Batter', 'nationality': 'India', 'isOverseas': False, 'isCapped': True, 'basePrice': 2, 'form': 90, 'photoUrl': 'x'},
            'player-two': {'name': 'Player Two', 'role': 'Bowler', 'nationality': 'Australia', 'isOverseas': True, 'isCapped': True, 'basePrice': 1, 'form': 80, 'photoUrl': 'y'},
        }
        merged = gp.merge_records(players, meta)
        self.assertEqual([row['name'] for row in merged], ['Player One', 'Player Two'])
        self.assertEqual(merged[0]['role'], 'Batter')
        self.assertTrue(merged[1]['isOverseas'])


if __name__ == '__main__':
    unittest.main()
