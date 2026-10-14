// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Probe helper, never deployed: injected through eth_call state override. Like Multicall3's
// aggregate3, but every call gets a fixed gas allowance, so one call that burns all the gas
// it is given cannot starve the rest of the batch.
contract CappedMulticall {
    struct Call {
        address target;
        bytes data;
    }

    function run(Call[] calldata calls, uint256 gasEach) external returns (bool[] memory ok, bytes[] memory ret) {
        ok = new bool[](calls.length);
        ret = new bytes[](calls.length);
        for (uint256 i; i < calls.length; i++) {
            // Not enough left for a full allowance: report it rather than run short.
            if (gasleft() < gasEach + 30_000) {
                ret[i] = "skipped";
                continue;
            }
            (ok[i], ret[i]) = calls[i].target.call{gas: gasEach}(calls[i].data);
        }
    }
}
