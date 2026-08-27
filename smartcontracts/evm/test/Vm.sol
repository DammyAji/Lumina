// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The subset of Foundry's cheatcode interface these tests use.
/// @dev Declared locally so `forge test` runs without vendoring forge-std,
///      which keeps the contracts directory dependency-free.
interface Vm {
    function prank(address sender) external;
    function deal(address who, uint256 amount) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes4 revertData) external;
    function label(address addr, string calldata newLabel) external;
}

/// @notice Tiny assertion base so tests read the same way forge-std tests do.
abstract contract TestBase {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function assertEq(uint256 a, uint256 b, string memory err) internal pure {
        require(a == b, err);
    }

    function assertEq(address a, address b, string memory err) internal pure {
        require(a == b, err);
    }

    function assertEq(bytes32 a, bytes32 b, string memory err) internal pure {
        require(a == b, err);
    }

    function assertTrue(bool condition, string memory err) internal pure {
        require(condition, err);
    }
}
