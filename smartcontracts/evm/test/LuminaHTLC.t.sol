// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LuminaHTLC} from "../src/LuminaHTLC.sol";
import {TestBase} from "./Vm.sol";
import {MockERC20} from "./MockERC20.sol";

contract LuminaHTLCTest is TestBase {
    LuminaHTLC internal htlc;
    MockERC20 internal token;

    address internal sender = address(0xA11CE);
    address internal recipient = address(0xB0B);

    bytes32 internal constant SWAP_ID = bytes32(uint256(1));
    bytes32 internal constant PREIMAGE = bytes32(uint256(0x5EC7E7));
    uint256 internal constant AMOUNT = 1 ether;
    uint256 internal constant START_TIME = 1_000_000;
    uint256 internal constant TIMEOUT = START_TIME + 1 hours;

    bytes32 internal secretHash;

    function setUp() public {
        htlc = new LuminaHTLC();
        token = new MockERC20();
        secretHash = sha256(abi.encodePacked(PREIMAGE));

        vm.warp(START_TIME);
        vm.deal(sender, 10 ether);
        token.mint(sender, 10 ether);
    }

    function _lockNative() internal {
        vm.prank(sender);
        htlc.lockNative{value: AMOUNT}(SWAP_ID, recipient, secretHash, TIMEOUT);
    }

    function _lockERC20() internal {
        vm.prank(sender);
        token.approve(address(htlc), AMOUNT);
        vm.prank(sender);
        htlc.lockERC20(SWAP_ID, recipient, address(token), AMOUNT, secretHash, TIMEOUT);
    }

    function test_lockNative_escrowsTheFunds() public {
        _lockNative();

        LuminaHTLC.Swap memory swap = htlc.getSwap(SWAP_ID);
        assertEq(swap.sender, sender, "sender");
        assertEq(swap.recipient, recipient, "recipient");
        assertEq(swap.token, address(0), "token");
        assertEq(swap.amount, AMOUNT, "amount");
        assertEq(swap.secretHash, secretHash, "secretHash");
        assertEq(swap.timeout, TIMEOUT, "timeout");
        assertTrue(swap.status == LuminaHTLC.Status.Locked, "status");
        assertEq(address(htlc).balance, AMOUNT, "contract balance");
    }

    function test_lockNative_rejectsDuplicateSwapId() public {
        _lockNative();

        vm.expectRevert(LuminaHTLC.SwapAlreadyExists.selector);
        vm.prank(sender);
        htlc.lockNative{value: AMOUNT}(SWAP_ID, recipient, secretHash, TIMEOUT);
    }

    function test_lockNative_rejectsZeroAmount() public {
        vm.expectRevert(LuminaHTLC.InvalidAmount.selector);
        vm.prank(sender);
        htlc.lockNative{value: 0}(SWAP_ID, recipient, secretHash, TIMEOUT);
    }

    function test_lockNative_rejectsTimeoutInThePast() public {
        vm.expectRevert(LuminaHTLC.InvalidTimeout.selector);
        vm.prank(sender);
        htlc.lockNative{value: AMOUNT}(SWAP_ID, recipient, secretHash, START_TIME);
    }

    function test_lockNative_rejectsSelfAsRecipient() public {
        vm.expectRevert(LuminaHTLC.InvalidRecipient.selector);
        vm.prank(sender);
        htlc.lockNative{value: AMOUNT}(SWAP_ID, sender, secretHash, TIMEOUT);
    }

    function test_claim_paysRecipientAndRevealsPreimage() public {
        _lockNative();

        uint256 before = recipient.balance;
        vm.prank(recipient);
        htlc.claim(SWAP_ID, PREIMAGE);

        assertTrue(htlc.getSwap(SWAP_ID).status == LuminaHTLC.Status.Claimed, "status");
        assertEq(recipient.balance - before, AMOUNT, "recipient paid");
        assertEq(address(htlc).balance, 0, "contract drained");
        // The revealed preimage is what settles the Stellar leg of the swap.
        assertEq(htlc.getPreimage(SWAP_ID), PREIMAGE, "preimage revealed");
    }

    function test_claim_rejectsWrongPreimage() public {
        _lockNative();

        vm.expectRevert(LuminaHTLC.InvalidPreimage.selector);
        vm.prank(recipient);
        htlc.claim(SWAP_ID, bytes32(uint256(0xDEAD)));
    }

    function test_claim_rejectsCallerThatIsNotTheRecipient() public {
        _lockNative();

        vm.expectRevert(LuminaHTLC.NotRecipient.selector);
        vm.prank(sender);
        htlc.claim(SWAP_ID, PREIMAGE);
    }

    function test_claim_rejectsUnknownSwap() public {
        vm.expectRevert(LuminaHTLC.SwapNotFound.selector);
        vm.prank(recipient);
        htlc.claim(bytes32(uint256(99)), PREIMAGE);
    }

    function test_claim_rejectsAlreadyClaimedSwap() public {
        _lockNative();
        vm.prank(recipient);
        htlc.claim(SWAP_ID, PREIMAGE);

        vm.expectRevert(LuminaHTLC.SwapNotLocked.selector);
        vm.prank(recipient);
        htlc.claim(SWAP_ID, PREIMAGE);
    }

    function test_claim_rejectsExpiredTimelock() public {
        _lockNative();
        vm.warp(TIMEOUT);

        vm.expectRevert(LuminaHTLC.TimelockExpired.selector);
        vm.prank(recipient);
        htlc.claim(SWAP_ID, PREIMAGE);
    }

    function test_refund_returnsFundsAfterTimeout() public {
        _lockNative();
        vm.warp(TIMEOUT);

        uint256 before = sender.balance;
        vm.prank(sender);
        htlc.refund(SWAP_ID);

        assertTrue(htlc.getSwap(SWAP_ID).status == LuminaHTLC.Status.Refunded, "status");
        assertEq(sender.balance - before, AMOUNT, "sender repaid");
        assertEq(address(htlc).balance, 0, "contract drained");
    }

    function test_refund_rejectsBeforeTimeout() public {
        _lockNative();

        vm.expectRevert(LuminaHTLC.TimelockNotExpired.selector);
        vm.prank(sender);
        htlc.refund(SWAP_ID);
    }

    function test_refund_rejectsCallerThatIsNotTheSender() public {
        _lockNative();
        vm.warp(TIMEOUT);

        vm.expectRevert(LuminaHTLC.NotSender.selector);
        vm.prank(recipient);
        htlc.refund(SWAP_ID);
    }

    function test_refund_rejectsAlreadyClaimedSwap() public {
        _lockNative();
        vm.prank(recipient);
        htlc.claim(SWAP_ID, PREIMAGE);
        vm.warp(TIMEOUT);

        vm.expectRevert(LuminaHTLC.SwapNotLocked.selector);
        vm.prank(sender);
        htlc.refund(SWAP_ID);
    }

    function test_lockERC20_escrowsTokens() public {
        _lockERC20();

        assertEq(token.balanceOf(address(htlc)), AMOUNT, "contract holds tokens");
        assertEq(htlc.getSwap(SWAP_ID).token, address(token), "token recorded");
    }

    function test_claim_paysRecipientInTokens() public {
        _lockERC20();

        vm.prank(recipient);
        htlc.claim(SWAP_ID, PREIMAGE);

        assertEq(token.balanceOf(recipient), AMOUNT, "recipient paid");
        assertEq(token.balanceOf(address(htlc)), 0, "contract drained");
    }

    function test_refund_returnsTokensAfterTimeout() public {
        _lockERC20();
        vm.warp(TIMEOUT);

        uint256 before = token.balanceOf(sender);
        vm.prank(sender);
        htlc.refund(SWAP_ID);

        assertEq(token.balanceOf(sender) - before, AMOUNT, "sender repaid");
    }

    function test_getSwap_returnsInvalidStatusForUnknownSwap() public view {
        assertTrue(htlc.getSwap(bytes32(uint256(42))).status == LuminaHTLC.Status.Invalid, "status");
    }

    function test_getPreimage_returnsZeroWhileLocked() public {
        _lockNative();
        assertEq(htlc.getPreimage(SWAP_ID), bytes32(0), "preimage hidden");
    }
}
