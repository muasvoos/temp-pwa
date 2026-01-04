-- Rename ambient_room to ambient in temperature_readings table
UPDATE temperature_readings
SET sensor_name = 'ambient'
WHERE sensor_name = 'ambient_room';

-- Verify the update
SELECT sensor_name, COUNT(*) as count, MAX(ts_utc) as latest_reading
FROM temperature_readings
WHERE device_id = 'pi4'
GROUP BY sensor_name
ORDER BY sensor_name;
