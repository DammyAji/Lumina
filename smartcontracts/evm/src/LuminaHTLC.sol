// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal subset of ERC-20 used by the HTLC.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title LuminaHTLC
/// @notice Hash Time-Locked Contract for the Ethereum and Polygon legs of a
///         Lumina cross-chain swap.
///
/// A swap holds either native currency or an ERC-20 balance until one of two
/// terminal outcomes happens:
///
///  - the recipient reveals `preimage` where `sha256(preimage) == secretHash`
///    before `timeout` and receives the funds (`claim`), or
///  - `timeout` passes and the sender takes the funds back (`refund`).
///
/// Funds can therefore never be locked indefinitely. `claim` stores the
/// revealed preimage and emits it, which is what lets Lumina's coordinator
/// settle the Stellar leg of the same swap with the same secret.
///
/// sha256 is used rather than keccak256 so the same hashlock works unchanged on
/// Bitcoin (OP_SHA256), Solana, and Stellar.
contract LuminaHTLC {
    enum Status {
        Invalid,
        Locked,
        Claimed,
        Refunded
    }

    struct Swap {
        address sender;
        address recipient;
        address token; // address(0) for the chain's native currency
        uint256 amount;
        bytes32 secretHash;
        uint256 timeout; // unix timestamp at/after which refund is allowed
        Status status;
    }

    mapping(bytes32 => Swap) private _swaps;
    mapping(bytes32 => bytes32) private _preimages;

    event Locked(
        bytes32 indexed swapId,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 secretHash,
        uint256 timeout
    );
    event Claimed(bytes32 indexed swapId, address indexed recipient, bytes32 preimage);
    event Refunded(bytes32 indexed swapId, address indexed sender);

    error SwapAlreadyExists();
    error SwapNotFound();
    error SwapNotLocked();
    error InvalidAmount();
    error InvalidTimeout();
    error InvalidRecipient();
    error InvalidPreimage();
    error TimelockExpired();
    error TimelockNotExpired();
    error NotRecipient();
    error NotSender();
    error TransferFailed();

    /// @notice Locks native currency under `secretHash` until `timeout`.
    /// @param swapId Coordinator-assigned id, unique across all swaps.
    function lockNative(
        bytes32 swapId,
        address recipient,
        bytes32 secretHash,
        uint256 timeout
    ) external payable {
        _lock(swapId, recipient, address(0), msg.value, secretHash, timeout);
    }

    /// @notice Locks `amount` of `token` under `secretHash` until `timeout`.
    /// @dev The caller must have approved this contract for `amount` first.
    function lockERC20(
        bytes32 swapId,
        address recipient,
        address token,
        uint256 amount,
        bytes32 secretHash,
        uint256 timeout
    ) external {
        _lock(swapId, recipient, token, amount, secretHash, timeout);
        _safeTransferFrom(token, msg.sender, address(this), amount);
    }

    /// @notice Claims a locked swap by revealing the preimage of its hashlock.
    /// @dev Rejected once the timelock has expired, so a late claim can never
    ///      race the sender's refund window.
    function claim(bytes32 swapId, bytes32 preimage) external {
        Swap storage swap = _requireLocked(swapId);

        if (msg.sender != swap.recipient) revert NotRecipient();
        if (block.timestamp >= swap.timeout) revert TimelockExpired();
        if (sha256(abi.encodePacked(preimage)) != swap.secretHash) revert InvalidPreimage();

        swap.status = Status.Claimed;
        _preimages[swapId] = preimage;

        emit Claimed(swapId, swap.recipient, preimage);

        _payOut(swap.token, swap.recipient, swap.amount);
    }

    /// @notice Returns a locked swap's funds to its sender once `timeout` passes.
    function refund(bytes32 swapId) external {
        Swap storage swap = _requireLocked(swapId);

        if (msg.sender != swap.sender) revert NotSender();
        if (block.timestamp < swap.timeout) revert TimelockNotExpired();

        swap.status = Status.Refunded;

        emit Refunded(swapId, swap.sender);

        _payOut(swap.token, swap.sender, swap.amount);
    }

    /// @notice Returns the full swap record. `status` is `Invalid` if unknown.
    function getSwap(bytes32 swapId) external view returns (Swap memory) {
        return _swaps[swapId];
    }

    /// @notice Returns the preimage revealed by `claim`, or zero if unclaimed.
    function getPreimage(bytes32 swapId) external view returns (bytes32) {
        return _preimages[swapId];
    }

    function _lock(
        bytes32 swapId,
        address recipient,
        address token,
        uint256 amount,
        bytes32 secretHash,
        uint256 timeout
    ) private {
        if (_swaps[swapId].status != Status.Invalid) revert SwapAlreadyExists();
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0) || recipient == msg.sender) revert InvalidRecipient();
        // A timelock already in the past would let the sender refund immediately,
        // which defeats the point of locking the funds at all.
        if (timeout <= block.timestamp) revert InvalidTimeout();

        _swaps[swapId] = Swap({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            amount: amount,
            secretHash: secretHash,
            timeout: timeout,
            status: Status.Locked
        });

        emit Locked(swapId, msg.sender, recipient, token, amount, secretHash, timeout);
    }

    function _requireLocked(bytes32 swapId) private view returns (Swap storage swap) {
        swap = _swaps[swapId];
        if (swap.status == Status.Invalid) revert SwapNotFound();
        if (swap.status != Status.Locked) revert SwapNotLocked();
    }

    function _payOut(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeTransfer(token, to, amount);
        }
    }

    /// @dev Tolerates the non-standard ERC-20s that return no value at all.
    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
