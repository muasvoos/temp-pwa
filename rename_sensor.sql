-- Rename probe_target to test_probe in temperature_readings table
UPDATE temperature_readings
SET sensor_name = 'test_probe'
WHERE sensor_name = 'probe_target';

-- Verify the update
SELECT sensor_name, COUNT(*) as count
FROM temperature_readings
GROUP BY sensor_name
ORDER BY sensor_name;
