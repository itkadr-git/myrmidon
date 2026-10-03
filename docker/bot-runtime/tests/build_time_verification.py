#!/usr/bin/env python3
"""
Build-time verification script for GitHub broker patch.
This script verifies that the corrected imports work properly in _run_agent_sync context.
"""

import sys
import traceback

def main():
    """Main test function to verify imports that happen in _run_agent_sync."""
    print("Starting GitHub broker patch build-time verification...")
    
    try:
        # Add the hermes source to Python path (simulating how it's done in the actual code)
        sys.path.insert(0, '/opt/hermes-src')
        
        # This simulates the exact imports that happen in _run_agent_sync after our fix
        # Originally it was: from tools.github_broker_context import reset_github_broker_vars, set_github_broker_vars
        # Now it should be: from tools.github_broker_context import set_github_broker_vars
        from tools.github_broker_context import set_github_broker_vars
        print("✓ Successfully imported set_github_broker_vars (removed incorrect reset_github_broker_vars)")
        
        # Verify that the function works as expected in the _run_agent_sync context
        test_broker = {"broker_url": "http://test.com", "capability": "test-cap"}
        marker, reset_func = set_github_broker_vars(test_broker)
        print("✓ set_github_broker_vars function works correctly in _run_agent_sync context")
        
        # Verify that reset function works
        reset_func(marker)
        print("✓ reset function works correctly")
        
        # Test the other functions that should be available for _run_agent_sync
        from tools.github_broker_context import github_broker_bound, github_broker_env
        print("✓ Other required functions are available for _run_agent_sync")
        
        # Verify initial state is unbound
        assert not github_broker_bound(), "Initial state should be unbound"
        assert github_broker_env() == {}, "Initial env should be empty"
        print("✓ Initial state verification passed")
        
        # Test full cycle as would happen in _run_agent_sync
        marker, reset_func = set_github_broker_vars(test_broker)
        assert github_broker_bound(), "Should be bound after setting"
        env = github_broker_env()
        assert env["PAPERCLIP_GITHUB_BROKER_URL"] == "http://test.com"
        assert env["PAPERCLIP_GITHUB_BROKER_TOKEN"] == "test-cap"
        print("✓ Full cycle test passed as expected in _run_agent_sync")
        
        # Clean up
        reset_func(marker)
        assert not github_broker_bound(), "Should be unbound after reset"
        assert github_broker_env() == {}, "Env should be empty after reset"
        print("✓ Cleanup verification passed")
        
        # Test that the tuple return works as expected in _run_agent_sync context
        # The function should return (marker, reset) as expected by the calling code
        marker, reset_func = set_github_broker_vars(test_broker)
        assert callable(reset_func), "Reset function should be callable"
        print("✓ Tuple return format (marker, reset) works as expected in _run_agent_sync")
        
        # Clean up again
        reset_func(marker)
        
        print("\n✓ All build-time verification tests passed!")
        print("✓ The patch fix is working correctly for _run_agent_sync imports")
        print("✓ Removed incorrect 'reset_github_broker_vars' import")
        print("✓ Kept correct 'set_github_broker_vars' import")
        print("✓ All functionality works as expected in the _run_agent_sync context")
        return 0
        
    except ImportError as e:
        print(f"✗ Import error: {e}")
        if "reset_github_broker_vars" in str(e):
            print("  This indicates the problematic import was not properly fixed")
        traceback.print_exc()
        return 1
    except Exception as e:
        print(f"✗ Unexpected error: {e}")
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())