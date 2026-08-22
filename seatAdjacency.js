// PingPong — Seat Adjacency (Friendship/CP fix, 2026-08-11)
//
// Root cause of the "far away heart" bug: getSeatRelationshipLinks() in
// friendshipCp.js linked EVERY pair of seated users who had a relationship,
// with no concept of physical seat position at all. It never even checked
// Math.abs(a-b) === 1 — it just linked any two seated related users
// regardless of which seats they were in.
//
// This module is the single source of truth for "are these two seats
// physically next to each other". It is intentionally NOT
// `Math.abs(seatA - seatB) === 1` — the room's actual seat layout
// (public/style.css `.seat-grid{ grid-template-columns: repeat(4, 1fr) }`,
// server.js `seats: Array(8).fill(null)`) is a 4-column grid, i.e. seats
// are laid out as:
//
//   1  2  3  4
//   5  6  7  8
//
// Under naive Math.abs(a-b)===1, seat 4 and seat 5 would be considered
// "adjacent" (|4-5|=1) even though seat 4 is top-right and seat 5 is
// bottom-left — they are diagonally opposite corners, not neighbors.
// This module encodes the real 2D grid topology instead: two seats are
// adjacent only if they share a grid edge (directly left/right in the same
// row, or directly above/below in the same column) — never diagonal, and
// never across a row wrap (seat 4 / seat 5).
//
// Grid width is configurable via RELATIONSHIP_SEAT_GRID_COLUMNS so this
// stays correct if the room's seat count/layout ever changes; it defaults
// to 4 to match the current .seat-grid CSS.

const GRID_COLUMNS = Math.max(1, Number(process.env.RELATIONSHIP_SEAT_GRID_COLUMNS) || 4);

function seatRowCol(seatNumber, columns) {
  const cols = columns || GRID_COLUMNS;
  const idx = Number(seatNumber) - 1;
  return { row: Math.floor(idx / cols), col: idx % cols };
}

// areAdjacentSeats(seatA, seatB) -> boolean
// Returns true ONLY when seatA and seatB are physically neighboring seats
// in the room's actual grid layout (edge-adjacent, not diagonal, not the
// same seat).
function areAdjacentSeats(seatA, seatB, columns) {
  const a = Number(seatA);
  const b = Number(seatB);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) return false;
  if (a === b) return false;
  const posA = seatRowCol(a, columns);
  const posB = seatRowCol(b, columns);
  const rowDiff = Math.abs(posA.row - posB.row);
  const colDiff = Math.abs(posA.col - posB.col);
  // Edge-adjacent: same row and one column apart, OR same column and one
  // row apart. Diagonal neighbors (rowDiff===1 && colDiff===1) are
  // deliberately excluded — they don't share a seat-grid edge.
  return (rowDiff === 0 && colDiff === 1) || (colDiff === 0 && rowDiff === 1);
}

module.exports = { areAdjacentSeats, seatRowCol, GRID_COLUMNS };
