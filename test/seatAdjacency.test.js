// test/seatAdjacency.test.js
// Friendship/CP seat-adjacency fix (2026-08-11) — verifies seatAdjacency.js
// against the room's real 4-column seat grid (seats 1-8 laid out as two
// rows of 4: 1 2 3 4 / 5 6 7 8).
//
// Run: node test/seatAdjacency.test.js

const path = require("path");
const { areAdjacentSeats } = require(path.join(__dirname, "..", "seatAdjacency.js"));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

console.log("=== Spec examples (task's explicit test cases) ===");
{
  assert(areAdjacentSeats(1, 2) === true, "seat 1 + seat 2 => adjacent");
  assert(areAdjacentSeats(2, 3) === true, "seat 2 + seat 3 => adjacent");
  assert(areAdjacentSeats(1, 3) === false, "seat 1 + seat 3 => NOT adjacent");
  assert(areAdjacentSeats(1, 4) === false, "seat 1 + seat 4 => NOT adjacent");
}

console.log("=== Row-wrap corner case (the real reason Math.abs(a-b)===1 is wrong) ===");
{
  // Seat 4 is top-right of the grid, seat 5 is bottom-left. |4-5|===1 but
  // they are diagonal-opposite corners, not neighbors.
  assert(areAdjacentSeats(4, 5) === false, "seat 4 + seat 5 => NOT adjacent (different rows, row-wrap, not a real grid edge)");
}

console.log("=== Vertical (same column, adjacent row) neighbors ===");
{
  assert(areAdjacentSeats(1, 5) === true, "seat 1 + seat 5 => adjacent (directly below, same column)");
  assert(areAdjacentSeats(2, 6) === true, "seat 2 + seat 6 => adjacent");
  assert(areAdjacentSeats(3, 7) === true, "seat 3 + seat 7 => adjacent");
  assert(areAdjacentSeats(4, 8) === true, "seat 4 + seat 8 => adjacent");
}

console.log("=== Diagonal neighbors must NOT count ===");
{
  assert(areAdjacentSeats(1, 6) === false, "seat 1 + seat 6 => NOT adjacent (diagonal)");
  assert(areAdjacentSeats(2, 5) === false, "seat 2 + seat 5 => NOT adjacent (diagonal)");
  assert(areAdjacentSeats(4, 7) === false, "seat 4 + seat 7 => NOT adjacent (diagonal)");
}

console.log("=== Far seats ===");
{
  assert(areAdjacentSeats(1, 8) === false, "seat 1 + seat 8 => NOT adjacent (opposite corners)");
  assert(areAdjacentSeats(1, 7) === false, "seat 1 + seat 7 => NOT adjacent");
  assert(areAdjacentSeats(2, 8) === false, "seat 2 + seat 8 => NOT adjacent");
}

console.log("=== Symmetry ===");
{
  assert(areAdjacentSeats(2, 1) === true, "adjacency is symmetric: seat 2 + seat 1 => adjacent");
  assert(areAdjacentSeats(5, 1) === true, "adjacency is symmetric: seat 5 + seat 1 => adjacent");
}

console.log("=== Edge cases ===");
{
  assert(areAdjacentSeats(1, 1) === false, "a seat is never adjacent to itself");
  assert(areAdjacentSeats(0, 1) === false, "invalid seat number (0) => false, never throws");
  assert(areAdjacentSeats(null, 1) === false, "null seat => false, never throws");
  assert(areAdjacentSeats(undefined, undefined) === false, "undefined seats => false, never throws");
  assert(areAdjacentSeats("2", "3") === true, "numeric strings are coerced correctly (socket payloads are often strings)");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
