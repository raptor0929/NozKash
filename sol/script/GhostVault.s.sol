// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {GhostVault} from "../src/GhostVault.sol";

contract GhostVaultScript is Script {
    function run() public {
        uint256[4] memory pkMint = [
            vm.envOr("PK_MINT_X_IMAG", uint256(0)),
            vm.envOr("PK_MINT_X_REAL", uint256(0)),
            vm.envOr("PK_MINT_Y_IMAG", uint256(0)),
            vm.envOr("PK_MINT_Y_REAL", uint256(0))
        ];
        address mintAuthority = vm.envOr("MINT_AUTHORITY", address(0));
        vm.startBroadcast();
        new GhostVault(pkMint, mintAuthority);
        vm.stopBroadcast();
    }
}
